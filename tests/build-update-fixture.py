#!/usr/bin/env python3
"""Build a fictional next server release offline, without changing the checkout."""
import pathlib, shutil, subprocess, re, sys
root=pathlib.Path(__file__).resolve().parent.parent
previous='--previous' in sys.argv
fixture_name='noctua-previous-fixture' if previous else 'noctua-update-fixture'
project=root/('target/noctua-previous-fixture-source' if previous else 'target/update-fixture-source')
project.mkdir(parents=True,exist_ok=True)
for name in ['src','web']:
    shutil.copytree(root/name,project/name,dirs_exist_ok=True)
shutil.copytree(root/'app/icons',project/'app/icons',dirs_exist_ok=True)
for name in ['Cargo.lock','build.rs']:
    shutil.copy2(root/name,project/name)
(project/'build.rs').write_text((root/'build.rs').read_text()+'\n// Persistent release fixture source.\n')
manifest=(root/'Cargo.toml').read_text()
manifest=manifest.replace('members = ["app"]','members = []')
match=re.search(r'(\[workspace.package\]\nversion = ")(\d+)\.(\d+)\.(\d+)(")',manifest)
assert match,'expected stable workspace version'
patch=int(match[4])+(-1 if previous else 1)
assert patch>=0,'previous fixture requires a nonzero patch version'
version=f'{match[2]}.{match[3]}.{patch}'
manifest=manifest[:match.start()]+match[1]+version+match[5]+manifest[match.end():]
manifest+='\n[[bin]]\nname = "'+fixture_name+'"\npath = "src/main.rs"\n'
(project/'Cargo.toml').write_text(manifest)
subprocess.run(['cargo','build','--offline','--manifest-path',str(project/'Cargo.toml'),'--target-dir',str(root/'target'),'--bin',fixture_name],check=True)
print(root/('target/debug/'+fixture_name))
