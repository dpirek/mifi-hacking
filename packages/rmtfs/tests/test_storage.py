"""Build patched upstream storage.c against private files, never radio partitions.
Set RMTFS_SOURCE_DIR to an OpenWrt-prepared rmtfs source tree.
"""
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

@unittest.skipUnless(os.environ.get('RMTFS_SOURCE_DIR'), 'Set RMTFS_SOURCE_DIR to the patched upstream source tree')
class StorageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory();cls.root=Path(cls.tmp.name)
        cls.state=cls.root/'state';cls.binary=cls.root/'storage-test'
        source=Path(os.environ['RMTFS_SOURCE_DIR']).resolve()
        harness=cls.root/'test.c'
        harness.write_text('''#include "storage.c"
int main(int argc, char **argv) {
 if(argc!=3)return 2;
 storage_init(argv[1],!strcmp(argv[2],"ro"),false);
 struct rmtfd *f=storage_open(1,"/boot/modem_fs1");
 if(!f)return 3;
 if(storage_pwrite(f,"new",3,0)!=3)return 4;
 FILE *s=fopen(RMTFS_STORAGE_STATE,"r");char line[256];
 fgets(line,sizeof(line),s);fclose(s);fputs(line,stdout);
 if(!strcmp(argv[2],"sync-error")){close(f->fd);f->fd=-1;}
 storage_sync(f);
 s=fopen(RMTFS_STORAGE_STATE,"r");fgets(line,sizeof(line),s);fclose(s);fputs(line,stdout);
 storage_exit();return 0;
}
''')
        subprocess.run(shlex.split(os.environ.get('CC','cc'))+['-std=c11','-D_GNU_SOURCE','-Wall','-Wextra','-Werror','-Wno-sign-compare','-I'+str(source),'-DRMTFS_STORAGE_STATE='+json.dumps(str(cls.state)),str(harness),'-o',str(cls.binary)],check=True)
    @classmethod
    def tearDownClass(cls):cls.tmp.cleanup()
    def run_mode(self,mode):
        with tempfile.TemporaryDirectory(dir=self.root) as directory:
            file=Path(directory)/'modem_fs1';file.write_bytes(b'original-content')
            result=subprocess.run([str(self.binary),directory,mode],capture_output=True,text=True,check=True)
            states=[list(map(int,line.split())) for line in result.stdout.splitlines()]
            return states,file.read_bytes()
    def test_only_acknowledges_after_successful_fdatasync(self):
        (before,after),data=self.run_mode('rw')
        self.assertEqual(before[2:4],[0,0], 'pwrite alone must not count as a durable acknowledgement')
        self.assertEqual(after[2:4],[1,3]);self.assertEqual(after[5:],[0,0])
        self.assertTrue(data.startswith(b'new'))
    def test_readonly_shadow_writes_never_count_as_persistent(self):
        (before,after),data=self.run_mode('ro')
        self.assertEqual(before[2:4],[0,0]);self.assertEqual(after[2:4],[0,0])
        self.assertEqual(after[5],1);self.assertEqual(data,b'original-content')
    def test_failed_fsync_cannot_be_reported_as_committed(self):
        (_,after),_=self.run_mode('sync-error')
        self.assertEqual(after[2:4],[0,0]);self.assertNotEqual(after[6],0)

if __name__=='__main__':unittest.main()
