"""Exercise the real latest-SMS collector with fake modem JSON responses."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

HELPER = Path(__file__).parents[1] / 'files/latest-sms.sh'

class SMSTests(unittest.TestCase):
    def collect(self, messages, offline=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'fixtures').write_text(json.dumps(messages))
            mm = root/'mmcli'
            mm.write_text('''#!/usr/bin/python3
import json,os,sys
if os.environ.get('OFFLINE') == '1': sys.exit(1)
a=sys.argv[1:]
m=json.load(open(os.environ['FIXTURES']))
if '--messaging-list-sms' in a:
 print(json.dumps({'modem.messaging.sms':['/org/freedesktop/ModemManager1/SMS/'+i for i in m]}))
elif '-s' in a: print(json.dumps(m[a[a.index('-s')+1]]))
else: sys.exit(2)
''')
            mm.chmod(0o755)
            jf=root/'jsonfilter'
            jf.write_text('''#!/usr/bin/python3
import sys,json
a=sys.argv; value=json.loads(a[a.index('-s')+1]); expression=a[a.index('-e')+1]
if expression == '@["modem.messaging.sms"][*]':
 for path in value['modem.messaging.sms']: print(path)
else:
 for key in expression[2:].split('.'): value=value.get(key,{})
 if isinstance(value,str): print(value)
''')
            jf.chmod(0o755)
            env=dict(os.environ,PATH=str(root)+':'+os.environ['PATH'],FIXTURES=str(root/'fixtures'),OFFLINE=str(int(offline)))
            result=subprocess.run(['sh',str(HELPER)],env=env,capture_output=True,text=True,check=True,timeout=5)
            return result.stdout

    def message(self, sender, text, stamp, state='received'):
        return {'sms':{'properties':{'state':state,'timestamp':stamp},'content':{'number':sender,'text':text}}}

    def test_latest_received_uses_timestamp_and_timezone_not_message_id(self):
        messages={
            '9':self.message('Older','old','2026-11-15T10:00:00+02:00'),
            '1':self.message('Newer','Příliš žluťoučký\nSecond line','2026-11-15T08:30:00Z'),
            '12':self.message('Sent','outgoing','2026-11-15T12:00:00Z','sent'),
        }
        result=self.collect(messages)
        self.assertTrue(result.startswith('Newer'))
        self.assertIn('Příliš žluťoučký\nSecond line',result)
        self.assertNotIn('outgoing',result)

    def test_empty_inbox_and_disabled_modem(self):
        self.assertIn('No received SMS',self.collect({}))
        self.assertIn('modem is not ready',self.collect({},offline=True))

    def test_missing_timestamps_use_id_as_tie_break(self):
        self.assertIn('newer ID',self.collect({'1':self.message('1','old','--'),'3':self.message('3','newer ID','--')}))

if __name__=='__main__': unittest.main()
