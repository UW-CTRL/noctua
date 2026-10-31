"""Pass a current-run server artifact to the desktop hook without recompiling it."""
import hashlib
import json
import os
from pathlib import Path

root = Path('prebuilt-server').resolve()
metadata = json.loads((root / f'server-update-{os.environ["SERVER_TARGET"]}.json').read_text())
binary = root / metadata['binary']
assert binary.parent == root and binary.is_file(), 'Invalid prebuilt server path'
assert hashlib.sha256(binary.read_bytes()).hexdigest() == metadata['sha256'], 'Prebuilt server checksum mismatch'
assert not any(c in str(binary) for c in '\r\n'), 'Invalid prebuilt server path'
with open(os.environ['GITHUB_ENV'], 'a') as output:
    output.write(f'NOCTUA_SERVER_BINARY={binary}\nNOCTUA_SERVER_SHA256={metadata["sha256"]}\n')
