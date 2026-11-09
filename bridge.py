"""Private stdio bridge. It never starts a WeChat sender or advances the world."""
import argparse
from contextlib import contextmanager
from copy import deepcopy
import json
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from virtual_character.application import Application
from virtual_character.desktop_pet import DesktopPipeline
from virtual_character.frontend import DshGatewayOwner, load_config, make_router
from virtual_character.storage import Store

OUTPUT = threading.Lock()


def emit(value):
    with OUTPUT:
        print(json.dumps(value, ensure_ascii=False), flush=True)


class Bridge:
    def __init__(self, config):
        self.config = config
        self.session = 'desktop:' + uuid4().hex
        with Store.open_readonly(config['database']) as store:
            router = make_router(Application(store), config)
            owner = next(r for r in router.routes.values() if r.conversation_id == router.owner_conversation_id)
            self.contact, self.character = owner.contact_id, owner.character_id
        self.generation = self.observation_generation = 0
        self.closed = False
        self.wake = threading.Event()
        self.latest = None
        self.asr = self.tts = None
        self.reply_busy = False
        self.waiting_screen = None
        self.gateway_config = deepcopy(config)
        self.gateway_config['models']['home'] = config['models']['home'] / 'desktop-pet' / self.session.split(':')[-1]
        self.gateway_config['models']['call'] = dict(config['models'].get('call', {}), transport='provider_text')
        self.thread = threading.Thread(target=self.replies, daemon=True)
        self.thread.start()

    @contextmanager
    def pipeline(self, gateway=None, readonly=False):
        opener = Store.open_readonly if readonly else Store
        with opener(self.config['database']) as store:
            yield DesktopPipeline(Application(store), gateway, self.session, self.contact, self.character)

    def stop_audio(self):
        process, self.tts = self.tts, None
        if process and process.poll() is None:
            process.terminate()
        emit({'type': 'audio_stop'})

    def interrupt(self):
        self.generation += 1
        self.stop_audio()
        with self.pipeline() as pipeline:
            pipeline.cancel_outbounds()
        emit({'type': 'cancelled', 'generation': self.generation})

    def replies(self):
        failed_generation = None
        with DshGatewayOwner(self.gateway_config) as gateway:
            while not self.closed:
                self.wake.wait(1)
                self.wake.clear()
                generation = self.generation
                if generation == failed_generation:
                    continue
                if generation == self.waiting_screen:
                    continue
                try:
                    with self.pipeline(gateway) as pipeline:
                        if not pipeline.pending():
                            continue
                        if not pipeline.status()['available']:
                            continue
                        self.reply_busy = True
                        emit({'type': 'thinking'})
                        evidence = self.latest if (self.latest and time.time() - self.latest['captured_at'] < 60
                            and self.latest['privacy_epoch'] == pipeline.status()['privacy_epoch']) else None
                        result = pipeline.process(generation, lambda: self.closed or generation != self.generation, evidence)
                    if result and generation == self.generation and not self.closed:
                        emit(result)
                except Exception as error:
                    emit({'type': 'error', 'message': '回复暂未完成', 'detail': type(error).__name__})
                    failed_generation = generation
                finally:
                    self.reply_busy = False

    def observation(self, command, generation, observation_generation):
        captured = min(s['captured_at'] for s in command['screens'])
        def cancelled():
            return (self.closed or generation != self.generation
                or observation_generation != self.observation_generation or time.time() - captured > 60)
        try:
            with DshGatewayOwner(self.gateway_config) as gateway, self.pipeline(gateway) as pipeline:
                evidence = pipeline.observe(command['screens'], cancelled)
                if not evidence or cancelled():
                    return
                self.latest = evidence
                emit({'type': 'observed', 'screen_count': evidence['screen_count']})
                if not command.get('manual') and command.get('may_speak') and not self.reply_busy and not pipeline.pending():
                    try:
                        result = pipeline.process(generation, cancelled, evidence, proactive=True)
                        if result and not cancelled():
                            emit(result)
                    except Exception as error:
                        emit({'type': 'error', 'message': '主动回复暂未完成', 'detail': type(error).__name__})
        except Exception as error:
            emit({'type': 'error', 'message': '这次没能看清屏幕', 'detail': type(error).__name__})
        finally:
            if self.waiting_screen == generation:
                self.waiting_screen = None
                self.wake.set()
            emit({'type': 'observation_finished'})

    def start_asr(self):
        self.stop_asr()
        process = subprocess.Popen([sys.executable, str(ROOT / 'deploy/call_asr.py')],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.asr = process
        def events():
            for line in process.stdout:
                if self.closed or self.asr is not process:
                    break
                event = json.loads(line)
                kind = event.get('type')
                if kind == 'speech_start':
                    self.interrupt()
                if kind == 'transcript' and event.get('text'):
                    with self.pipeline() as pipeline:
                        pipeline.submit(event['text'], uuid4().hex, 'voice')
                    emit({'type': 'transcript', 'text': event['text']})
                    self.wake.set()
                else:
                    emit(dict(event, type='asr_' + str(kind)))
            if self.asr is process and not self.closed:
                self.asr = None
                emit({'type': 'error', 'source': 'microphone', 'message': '语音识别已停止'})
        threading.Thread(target=events, daemon=True).start()

    def stop_asr(self):
        process, self.asr = self.asr, None
        if process:
            if process.stdin and not process.stdin.closed:
                process.stdin.close()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.terminate()

    def speak(self, command):
        self.stop_audio()
        generation = self.generation
        with self.pipeline(readonly=True) as pipeline:
            outbound = pipeline.app.store.outbound(command['outbound_id'])['payload']
            if (not command['outbound_id'].startswith(self.session + ':') or
                    outbound['privacy_epoch'] != pipeline.status()['privacy_epoch'] or
                    command['generation'] != generation):
                return
        settings = json.loads((ROOT / 'config/voice-call.json').read_text())['streaming_tts']
        settings.update(text=' '.join(part['text'] for part in outbound['parts']), delivery=command.get('delivery'))
        process = subprocess.Popen([settings['python'], str(ROOT / 'deploy/call_tts.py')],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.tts = process
        process.stdin.write((json.dumps(settings, ensure_ascii=False) + '\n').encode())
        process.stdin.close()
        def stream():
            import base64
            emit({'type': 'audio_start', 'generation': generation})
            while not self.closed and self.tts is process and generation == self.generation:
                chunk = process.stdout.read(4096)
                if not chunk:
                    break
                emit({'type': 'audio_chunk', 'generation': generation, 'pcm': base64.b64encode(chunk).decode()})
            code = process.wait()
            if self.tts is process:
                self.tts = None
                emit({'type': 'audio_end', 'generation': generation, 'complete': code == 0,
                    'outbound_id': command['outbound_id']})
        threading.Thread(target=stream, daemon=True).start()

    def command(self, command):
        operation = command['operation']
        if operation == 'status':
            with self.pipeline(readonly=True) as pipeline:
                emit(dict(pipeline.status(), type='status'))
        elif operation == 'input':
            self.interrupt()
            with self.pipeline() as pipeline:
                result = pipeline.submit(command['text'], command['message_id'])
            emit({'type': 'accepted', 'held': result['held']})
            self.wake.set()
        elif operation == 'observe':
            if command.get('manual'):
                self.interrupt()
                self.latest = None
                self.waiting_screen = self.generation
                with self.pipeline() as pipeline:
                    pipeline.submit(command.get('text') or '看看我在做什么，陪我聊聊吧。', uuid4().hex)
            threading.Thread(target=self.observation,
                args=(command, self.generation, self.observation_generation), daemon=True).start()
        elif operation == 'pause_observation':
            self.observation_generation += 1
            self.latest = None
        elif operation == 'interrupt':
            self.interrupt()
        elif operation == 'audio_stop':
            self.stop_audio()
        elif operation == 'ack':
            with self.pipeline() as pipeline:
                pipeline.acknowledge(command['outbound_id'], command['index'])
        elif operation == 'mic_start':
            self.start_asr()
        elif operation == 'mic_stop':
            self.stop_asr()
        elif operation == 'pcm':
            import base64
            if self.asr and self.asr.poll() is None and len(command['pcm']) < 100000:
                self.asr.stdin.write(base64.b64decode(command['pcm'], validate=True))
                self.asr.stdin.flush()
        elif operation == 'speak':
            self.speak(command)
        elif operation == 'audio_receipt':
            with self.pipeline() as pipeline:
                ident = command['outbound_id']
                if ident.startswith(self.session + ':'):
                    with pipeline.app.store.db:
                        pipeline.app.store._event(ident, None, 'DesktopAudioDelivery',
                            pipeline.app.now_ms(self.character), 'desktop', {'complete': bool(command['complete'])})
        elif operation == 'close':
            self.closed = True
            self.generation += 1
            self.observation_generation += 1
            self.stop_audio()
            self.stop_asr()
            self.wake.set()
            with self.pipeline() as pipeline:
                pipeline.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', type=Path, default=ROOT / 'config/local.json')
    args = parser.parse_args()
    bridge = Bridge(load_config(args.config))
    emit({'type': 'connected'})
    try:
        for line in sys.stdin:
            try:
                if len(line) > 100 * 1024 * 1024:
                    raise ValueError('请求过大')
                bridge.command(json.loads(line))
            except Exception as error:
                emit({'type': 'error', 'message': '操作未完成', 'detail': type(error).__name__})
            if bridge.closed:
                break
    finally:
        if not bridge.closed:
            bridge.command({'operation': 'close'})


if __name__ == '__main__':
    main()
