"""Status collection tests using fake sysfs and modem tools, never hardware."""
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

FILES = Path(__file__).parents[1] / 'files'


class MetricsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.power = self.root / 'power'; self.power.mkdir()
        self.battery = self.power / 'battery'; self.battery.mkdir()
        self.put(self.battery / 'type', 'Battery')
        self.net = self.root / 'net'
        self.state = self.root / 'state'

    def put(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(str(value) + '\n')

    def shell(self, expression):
        return subprocess.check_output(['sh', '-c', '. "$1"; ' + expression, 'test', str(FILES / 'metrics.sh')], text=True).strip()

    def battery_result(self):
        return self.shell('display_battery ' + shlex.quote(str(self.power)) + '; echo "$BATTERY $BATTERY_ESTIMATED $CHARGING"')

    def counters(self, rx, tx, iface='wwan0'):
        for name, value in (('rx_bytes', rx), ('tx_bytes', tx)):
            self.put(self.net / iface / 'statistics' / name, value)

    def rates(self, now, iface='wwan0'):
        return self.shell('display_transfer_rates ' + ' '.join(shlex.quote(str(v)) for v in (iface, self.net, self.state, now)))

    def test_reported_battery_capacity_is_preferred(self):
        self.put(self.battery / 'capacity', 72); self.put(self.battery / 'status', 'Charging')
        self.assertEqual(self.battery_result(), '72 0 1')

    def test_voltage_estimate_is_marked(self):
        for key, value in [('voltage_now', 3875000), ('voltage_min_design', 3400000), ('voltage_max_design', 4350000)]:
            self.put(self.battery / key, value)
        self.assertEqual(self.battery_result(), '50 1 0')

    def test_estimate_clamps_to_full(self):
        for key, value in [('voltage_now', 4478100), ('voltage_min_design', 3400000), ('voltage_max_design', 4350000)]:
            self.put(self.battery / key, value)
        self.assertEqual(self.battery_result(), '100 1 0')

    def test_missing_battery_data_is_unknown(self):
        self.assertEqual(self.battery_result(), '-1 0 0')

    def test_invalid_voltage_range_is_unknown(self):
        for key in ('voltage_now', 'voltage_min_design', 'voltage_max_design'):
            self.put(self.battery / key, 4000000)
        self.assertEqual(self.battery_result(), '-1 0 0')

    def test_signal_requires_recent_measurement(self):
        for recent, expected in [('yes', '60'), ('no', '-1')]:
            snapshot = f'modem.generic.signal-quality.value : 60\nmodem.generic.signal-quality.recent : {recent}'
            self.assertEqual(self.shell('display_signal ' + shlex.quote(snapshot) + '; echo "$SIGNAL"'), expected)

    def test_invalid_signal_is_unknown(self):
        snapshot = 'modem.generic.signal-quality.value : 150\nmodem.generic.signal-quality.recent : yes'
        self.assertEqual(self.shell('display_signal ' + shlex.quote(snapshot) + '; echo "$SIGNAL"'), '-1')

    def test_first_traffic_sample_needs_baseline(self):
        self.counters(10000, 2000)
        self.assertEqual(self.rates(10), '--\t--')

    def test_throughput_uses_monotonic_time(self):
        self.counters(10000, 2000); self.rates(10)
        self.counters(14096, 3024)
        self.assertEqual(self.rates(12), '2.0 KiB/s\t512 B/s')

    def test_cellular_zero_counters_use_nft_accounting(self):
        self.counters(0,0)
        fake = self.root/'nft'
        fake.write_text('#!/bin/sh\ncase "$5" in rx) bytes=$(cat "$TEST_NFT_RX");; tx) bytes=$(cat "$TEST_NFT_TX");; esac\necho "packets 4 bytes $bytes"\n')
        fake.chmod(0o755)
        rx=self.root/'nft-rx'; tx=self.root/'nft-tx'
        self.put(rx,1000);self.put(tx,500)
        setup='export DISPLAY_NFT_BIN='+shlex.quote(str(fake))+' TEST_NFT_RX='+shlex.quote(str(rx))+' TEST_NFT_TX='+shlex.quote(str(tx))+'; '
        def sample(now):
            return self.shell(setup+'display_transfer_rates '+' '.join(shlex.quote(str(v)) for v in ('wwan0',self.net,self.state,now,'raw')))
        self.assertEqual(sample(10),'--\t--\t-1')
        self.put(rx,5096);self.put(tx,1524)
        self.assertEqual(sample(12),'2.0 KiB/s\t512 B/s\t2560')
        self.assertTrue(self.state.read_text().startswith('nft:wwan0 '))
        self.put(rx,0);self.put(tx,0)
        self.assertEqual(sample(13),'--\t--\t-1','Reset firewall counters need a fresh baseline')

    def test_raw_combined_flow_and_bar_scale(self):
        self.counters(10000,2000)
        expression = 'display_transfer_rates ' + ' '.join(shlex.quote(str(v)) for v in ('wwan0',self.net,self.state,10,'raw'))
        self.assertEqual(self.shell(expression),'--\t--\t-1')
        self.counters(14096,3024)
        expression = 'display_transfer_rates ' + ' '.join(shlex.quote(str(v)) for v in ('wwan0',self.net,self.state,12,'raw'))
        self.assertEqual(self.shell(expression),'2.0 KiB/s\t512 B/s\t2560')
        for rate,expected in [(0,'0'),(1,'1'),(625000,'50'),(1250000,'100'),(2500000,'100'),(-1,'-1')]:
            self.assertEqual(self.shell('display_flow_percent '+str(rate)+' 10'),expected)

    def test_reset_counters_never_create_negative_rates(self):
        self.counters(10000, 2000); self.rates(10)
        self.counters(100, 20)
        self.assertEqual(self.rates(12), '--\t--')

    def test_stale_sample_and_interface_changes_reset_baseline(self):
        self.counters(10000, 2000); self.rates(10)
        self.counters(20000, 3000)
        self.assertEqual(self.rates(60), '--\t--')
        self.counters(30000, 3000, 'br-lan')
        self.assertEqual(self.rates(62, 'br-lan'), '--\t--')

    def test_missing_interface_is_unknown(self):
        self.assertEqual(self.rates(1), '--\t--')

    def updater(self, valid_frame=True, page='status'):
        bindir = self.root / 'bin'; bindir.mkdir()
        scripts = {
            'sms-helper': '#!/bin/sh\nprintf "+420123456789\\nLatest SMS body\\n"\n',
            'uci': '#!/bin/sh\ncase "$*" in *traffic_interface) echo wwan0;; *page) echo status;; esac\n',
            'mmcli': '#!/bin/sh\n: > \"$MODEM_TOUCH\"\nif [ "$1" = -L ]; then echo /org/freedesktop/ModemManager1/Modem/0; else cat "$MODEM_FIXTURE"; fi\n',
        }
        for name, body in scripts.items():
            p=bindir/name; p.write_text(body); p.chmod(0o755)
        fixture = self.root / 'modem'
        fixture.write_text('modem.generic.own-numbers : +420123456789\nmodem.generic.equipment-identifier : 490154203237518\nmodem.generic.signal-quality.value : 68\nmodem.generic.signal-quality.recent : yes\nmodem.generic.access-technologies : lte\nmodem.3gpp.operator-name : Test network\nmodem.3gpp.registration-state : home\n')
        renderer = bindir / 'render'
        renderer.write_text('#!/usr/bin/python3\nimport os,sys,json\nopen(os.environ["ARGV_CAPTURE"],"w").write(json.dumps(sys.argv[1:]))\nsys.stdout.buffer.write(bytes(' + ('32768' if valid_frame else '4') + '))\n')
        renderer.chmod(0o755)
        framebuffer = self.root / 'fb'; framebuffer.write_bytes(b'previous-frame')
        capture = self.root / 'args'
        self.counters(10000, 2000)
        env = dict(os.environ, PATH=str(bindir) + ':' + os.environ['PATH'], MODEM_FIXTURE=str(fixture), MODEM_TOUCH=str(self.root/'modem-touched'), DISPLAY_PAGE=page,
                   DISPLAY_SMS_HELPER=str(bindir/'sms-helper'), DISPLAY_SMS_FILE=str(self.root/'sms-snapshot'),
                   DISPLAY_METRICS_LIB=str(FILES/'metrics.sh'), DISPLAY_POWER_ROOT=str(self.power),
                   DISPLAY_NET_ROOT=str(self.net), DISPLAY_TRAFFIC_STATE=str(self.state),
                   ROUTER_DISPLAY_BIN=str(renderer), DISPLAY_FRAMEBUFFER=str(framebuffer), ARGV_CAPTURE=str(capture))
        return subprocess.run(['sh',str(FILES/'update-display.sh')],env=env,capture_output=True,text=True), framebuffer, capture

    def test_updater_supplies_all_dashboard_fields(self):
        import json
        self.put(self.battery / 'capacity', 72)
        r, framebuffer, capture = self.updater()
        self.assertEqual(r.returncode,0,r.stderr)
        args=json.loads(capture.read_text())
        for option, value in [('-b','72'),('-i','490154203237518'),('-N','+420123456789'),('-g','68'),('-f','CELL wwan0')]:
            self.assertEqual(args[args.index(option)+1],value)
        self.assertIn('-d',args)
        self.assertEqual(framebuffer.stat().st_size,32768)

    def test_sms_snapshot_skips_status_queries_and_renders_sms_page(self):
        import json
        result, framebuffer, capture = self.updater(page='sms')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(capture.read_text()),['-m','-j','0'])
        self.assertIn('Latest SMS body',(self.root/'sms-snapshot').read_text())
        self.assertEqual((self.root/'sms-snapshot').stat().st_mode & 0o777,0o600)
        self.assertFalse((self.root/'modem-touched').exists())
        self.assertEqual(framebuffer.stat().st_size,32768)

    def test_sleep_ping_uses_cached_history_without_modem_queries(self):
        import json
        result, framebuffer, capture = self.updater(page='ping')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(capture.read_text()),['-P'])
        self.assertFalse((self.root/'modem-touched').exists())
        self.assertEqual(framebuffer.stat().st_size,32768)

    def test_clock_skips_modem_and_status_sampling(self):
        import json
        result, framebuffer, capture = self.updater(page='clock')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(capture.read_text()),['-a'])
        self.assertEqual(framebuffer.stat().st_size,32768)
        self.assertFalse((self.root/'modem-touched').exists())

    def test_bad_render_never_overwrites_framebuffer(self):
        r, framebuffer, _ = self.updater(valid_frame=False)
        self.assertNotEqual(r.returncode,0)
        self.assertEqual(framebuffer.read_bytes(),b'previous-frame')


@unittest.skipUnless(os.environ.get('DISPLAY_RENDERER_BINARY'), 'Set DISPLAY_RENDERER_BINARY to test the compiled renderer')
class RendererTests(unittest.TestCase):
    def test_sms_wraps_unicode_and_pages_without_clipping(self):
        binary = os.environ['DISPLAY_RENDERER_BINARY']
        message = ('+420123456789\nPříliš žluťoučký kůň. ' + 'A long SMS message with words. ' * 15).encode()
        frames = []
        for page in (0, 1, 0):
            result = subprocess.run([binary, '-m', '-j', str(page)], input=message, capture_output=True, check=True)
            self.assertEqual(len(result.stdout), 32768)
            frames.append(result.stdout)
        self.assertNotEqual(frames[0], frames[1])
        self.assertEqual(frames[0], frames[2])
        for text in (b'', b'Sender\nInvalid \xff\xe2\x82', b'Sender\n' + b'X' * 8192):
            result = subprocess.run([binary, '-m', '-j', '99999'], input=text, capture_output=True, check=True)
            self.assertEqual(len(result.stdout), 32768)

    def test_ping_graph_downsamples_peaks_and_preserves_timeouts(self):
        now=1800000000
        data=f'{now-3590} 10\n{now-3580} 150\n{now-300} -1\n{now} 300\n{now-3700} 99999\n{now} nan\n'.encode()
        result=subprocess.run([os.environ['DISPLAY_RENDERER_BINARY'],'-P','-Z',str(now)],input=data,capture_output=True,check=True)
        frame=result.stdout
        self.assertEqual(len(frame),32768)
        rgb=lambda r,g,b:((r&248)<<8)|((g&252)<<3)|(b>>3)
        pixel=lambda x,y:int.from_bytes(frame[(y*128+x)*2:(y*128+x)*2+2],'little')
        self.assertEqual(pixel(6,95),rgb(99,222,176),'Peak survives grouping multiple samples into one pixel column')
        self.assertEqual(pixel(112,121),rgb(196,88,97),'Timeout is a red one-pixel baseline marker')
        self.assertNotEqual(pixel(112,68),rgb(196,88,97),'Timeout must not imply a maximum-latency bar')
        self.assertEqual(pixel(120,68),rgb(99,222,176),'Latest sample is at the right edge')
        self.assertFalse(any(frame[:6*256]))
        self.assertFalse(any(frame[122*256:]))
        empty=subprocess.run([os.environ['DISPLAY_RENDERER_BINARY'],'-P','-Z',str(now)],input=b'',capture_output=True,check=True).stdout
        self.assertTrue(any(empty[:64*256]),'Statistics occupy the upper half')
        colors={int.from_bytes(empty[i:i+2],'little') for i in range(64*256,len(empty),2)}
        self.assertEqual(colors,{0,rgb(25,34,46)},'Missing history draws only a grid in the lower half')

    def test_analog_clock_moves_second_hand(self):
        def frame(value):
            p=subprocess.run([os.environ['DISPLAY_RENDERER_BINARY'],'-a','-T',value],capture_output=True,check=True)
            self.assertEqual(len(p.stdout),32768)
            return p.stdout
        top=frame('10:09:00'); right=frame('10:09:15')
        accent=((99 & 0xF8)<<8)|((222 & 0xFC)<<3)|((176 & 0xF8)>>3)
        pixel=lambda data,x,y:int.from_bytes(data[(y*128+x)*2:(y*128+x)*2+2],'little')
        self.assertEqual(pixel(top,64,23),accent)
        self.assertEqual(pixel(right,105,64),accent)
        self.assertNotEqual(pixel(top,105,64),accent)
        self.assertNotEqual(pixel(right,64,23),accent)
        self.assertEqual(set(top[116*128*2:]),{0},'No digital time beneath the centered analog dial')
        invalid=subprocess.run([os.environ['DISPLAY_RENDERER_BINARY'],'-a','-T','99:00:00'],capture_output=True)
        self.assertNotEqual(invalid.returncode,0)
        self.assertEqual(invalid.stdout,b'')

    def test_dashboard_frame_size_and_pixel_content(self):
        p=subprocess.run([os.environ['DISPLAY_RENDERER_BINARY'],'-d','-b','72','-g','68','-i','490154203237518','-r','1.2 MiB/s','-x','84 KiB/s'],capture_output=True,check=True)
        self.assertEqual(len(p.stdout),32768)
        self.assertGreater(len(set(p.stdout)),10)

    def test_unknown_readings_and_long_names_do_not_overflow(self):
        p=subprocess.run([os.environ['DISPLAY_RENDERER_BINARY'],'-d','-b','-1','-g','-1','-n','X'*1000],capture_output=True,check=True)
        self.assertEqual(len(p.stdout),32768)

    def test_wifi_qr_layout_still_renders(self):
        p=subprocess.run([os.environ['DISPLAY_RENDERER_BINARY'],'-q','-s','Test','-p','test-password'],capture_output=True,check=True)
        self.assertEqual(len(p.stdout),32768)


if __name__=='__main__':unittest.main()
