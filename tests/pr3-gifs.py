"""Encode isolated Reader recording frames with per-step timing (requires FFmpeg)."""
import json
import pathlib
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parents[1]
scenes = sys.argv[1:] or ['outline', 'auto-highlight', 'attachments']
for scene in scenes:
    if scene not in {'outline', 'auto-highlight', 'attachments'}:
        raise SystemExit(f'Unknown recording: {scene}')
    frames = root / 'target/pr3-recording/frames' / scene
    manifest = json.loads((frames / 'manifest.json').read_text())
    lines = []
    for frame in manifest:
        path = frames / frame['file']
        # Concat paths are relative to the manifest and contain only generated filenames.
        lines.extend([f"file '{path.name}'", f"duration {frame['duration'] / 1000:.2f}"])
    lines.append(f"file '{manifest[-1]['file']}'")
    concat = frames / 'frames.txt'
    concat.write_text('\n'.join(lines) + '\n')
    output = root / f'docs/images/pr-3/{scene}.gif'
    subprocess.run([
        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'concat', '-safe', '1', '-i', str(concat),
        '-filter_complex',
        'scale=1400:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192[p];[b][p]paletteuse=dither=bayer:bayer_scale=5',
        '-fps_mode', 'vfr', '-loop', '0', str(output),
    ], check=True)
    print(f'Saved {output.relative_to(root)} ({output.stat().st_size:,} bytes)')
