#!/usr/bin/python3
import base64
import json
import os
import sys

import gi
gi.require_version('Gst', '1.0')
from gi.repository import Gio, GLib, Gst

PORTAL = 'org.freedesktop.portal.Desktop'
PATH = '/org/freedesktop/portal/desktop'
SCREENCAST = 'org.freedesktop.portal.ScreenCast'


class Capture:
    def __init__(self):
        Gst.init(None)
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.session = None
        self.pipelines = []
        self.streams = []
        self.fd = None

    def request(self, method, signature, args, options):
        token = f'dworld_{GLib.get_monotonic_time()}'
        sender = self.bus.get_unique_name().replace('.', '_').lstrip(':')
        path = f'{PATH}/request/{sender}/{token}'
        loop = GLib.MainLoop()
        result = []

        def response(_bus, _sender, _path, _interface, _signal, parameters):
            result.append(parameters.unpack())
            loop.quit()

        subscription = self.bus.signal_subscribe(PORTAL, 'org.freedesktop.portal.Request', 'Response',
                                                  path, None, Gio.DBusSignalFlags.NONE, response)
        try:
            self.bus.call_sync(PORTAL, PATH, SCREENCAST, method,
                               GLib.Variant(signature, (*args, {'handle_token': GLib.Variant('s', token), **options})),
                               None, Gio.DBusCallFlags.NONE, -1, None)
            loop.run()
        finally:
            self.bus.signal_unsubscribe(subscription)
        code, values = result[0]
        if code:
            raise RuntimeError('屏幕共享未获授权或已取消')
        return values

    def open(self):
        session_token = f'dworld_session_{GLib.get_monotonic_time()}'
        self.session = self.request('CreateSession', '(a{sv})', (), {
            'session_handle_token': GLib.Variant('s', session_token)})['session_handle']
        self.request('SelectSources', '(oa{sv})', (self.session,), {
            'types': GLib.Variant('u', 1), 'multiple': GLib.Variant('b', True)})
        streams = self.request('Start', '(osa{sv})', (self.session, ''), {})['streams']
        if not streams:
            raise RuntimeError('没有选择屏幕')
        reply, fds = self.bus.call_with_unix_fd_list_sync(
            PORTAL, PATH, SCREENCAST, 'OpenPipeWireRemote',
            GLib.Variant('(oa{sv})', (self.session, {})), None, Gio.DBusCallFlags.NONE, -1, None, None)
        self.fd = fds.get(reply.unpack()[0])
        for node, properties in streams:
            pipeline = Gst.parse_launch(
                f'pipewiresrc fd={self.fd} path={node} keepalive-time=1000 ! '
                'videorate max-rate=2 ! videoconvert ! jpegenc quality=82 ! '
                'appsink name=sink max-buffers=1 drop=true sync=false')
            if pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
                raise RuntimeError('屏幕采集流无法启动')
            self.pipelines.append(pipeline)
            self.streams.append({'position': properties.get('position'), 'size': properties.get('size')})

    def capture(self):
        if not self.session:
            self.open()
        frames = []
        for pipeline, metadata in zip(self.pipelines, self.streams):
            sink = pipeline.get_by_name('sink')
            sink.emit('try-pull-sample', 0)
            sample = sink.emit('try-pull-sample', 3 * Gst.SECOND)
            if not sample:
                raise RuntimeError('屏幕共享已结束或没有画面')
            data = sample.get_buffer().extract_dup(0, sample.get_buffer().get_size())
            frames.append({**metadata, 'jpeg': base64.b64encode(data).decode('ascii')})
        return frames

    def close(self):
        for pipeline in self.pipelines:
            pipeline.set_state(Gst.State.NULL)
        if self.fd is not None:
            os.close(self.fd)
        if self.session:
            try:
                self.bus.call_sync(PORTAL, self.session, 'org.freedesktop.portal.Session', 'Close',
                                   None, None, Gio.DBusCallFlags.NONE, 1000, None)
            except GLib.Error:
                pass


def main():
    capture = Capture()
    try:
        for line in sys.stdin:
            command = json.loads(line)
            try:
                if command.get('operation') == 'start':
                    if not capture.session:
                        capture.open()
                    frames = []
                else:
                    frames = capture.capture()
                print(json.dumps({'id': command['id'], 'frames': frames}), flush=True)
            except Exception as error:
                print(json.dumps({'id': command['id'], 'error': str(error)}), flush=True)
                break
    finally:
        capture.close()


if __name__ == '__main__':
    main()
