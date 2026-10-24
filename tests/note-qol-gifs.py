"""Encode WebKit snapshot sequences, and update the PR README."""
import importlib.util
import json
import pathlib
import subprocess
import sys
sys.dont_write_bytecode=True
ROOT=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('media',ROOT/'tests/note-qol-media.py')
media=importlib.util.module_from_spec(spec);spec.loader.exec_module(media)
scenes=('workspace','note-history','bibliography','skills','reader-history')
for scene in sys.argv[1:] or scenes:
    if scene not in scenes: raise SystemExit('Unknown scene: '+scene)
    frames=ROOT/'target/note-qol-recording/frames'/scene
    manifest=json.loads((frames/'manifest.json').read_text())
    lines=[]
    for frame in manifest:
        lines.extend([f"file '{frame['file']}'",f"duration {frame['duration']/1000:.2f}"])
    lines.append(f"file '{manifest[-1]['file']}'")
    concat=frames/'frames.txt';concat.write_text('\n'.join(lines)+'\n')
    destination=ROOT/'docs/images';destination.mkdir(parents=True,exist_ok=True)
    output=destination/f'note-qol-{scene}.gif'
    subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','concat','-safe','1','-i',str(concat),
        '-filter_complex','scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192[p];[b][p]paletteuse=dither=bayer:bayer_scale=5',
        '-fps_mode','vfr','-loop','0',str(output)],check=True)
    subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-i',str(output),'-f','null','-'],check=True)
    media.embed(scene)
    print(f'{scene}: {len(manifest)} frames, {output.stat().st_size:,} bytes; decoded successfully')
