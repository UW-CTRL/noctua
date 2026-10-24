"""Capture real Noctua desktop demos on macOS and embed them in the PR README."""
import argparse
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCENES = {
    'workspace': 'Create a project folder and file, then expand the Media folder',
    'note-history': 'Edit a note and use the sticky Undo and Redo toolbar',
    'bibliography': 'Import and enable a bibliography, then insert an imported citation',
    'skills': 'Import a skill package, inspect its files, and enable it for a project',
    'reader-history': 'Create a PDF annotation, then undo and redo it',
}


def run(args):
    subprocess.run(args, check=True)


def encode(source, output, start=0, seconds=30):
    if not shutil.which('ffmpeg'):
        raise RuntimeError('FFmpeg is required to convert recordings.')
    run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
         '-ss', str(start), '-i', str(source), '-t', str(seconds),
         '-filter_complex',
         "fps=10,scale='min(1200,iw)':-1:flags=lanczos,split[a][b];"
         '[a]palettegen=max_colors=192[p];[b][p]paletteuse=dither=bayer:bayer_scale=5',
         '-loop', '0', str(output)])


def embed(scene):
    readme = ROOT / 'docs/pr-note-qol.md'
    text = readme.read_text()
    begin, end = f'<!-- media:{scene} -->', f'<!-- /media:{scene} -->'
    if begin not in text or end not in text:
        raise RuntimeError(f'Missing media markers for {scene}')
    images = []
    for extension in ('gif',):
        path = ROOT / f'docs/images/note-qol-{scene}.{extension}'
        if path.is_file():
            images.append(f'![{SCENES[scene]}](images/{path.name})')
    prefix, rest = text.split(begin, 1)
    _, suffix = rest.split(end, 1)
    readme.write_text(prefix + begin + '\n' + '\n\n'.join(images) + '\n' + end + suffix)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('scene', choices=SCENES)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--record', action='store_true', help='Select a desktop region and record a demo')
    action.add_argument('--screenshot', action='store_true', help='Select the Noctua window for a PNG')
    action.add_argument('--video', type=pathlib.Path, help='Convert an existing screen recording')
    parser.add_argument('--start', type=float, default=0, help='Trim seconds from the recording start')
    parser.add_argument('--seconds', type=float, default=30, help='Maximum recording/GIF duration')
    args = parser.parse_args()
    if args.start < 0 or not 0 < args.seconds <= 120:
        parser.error('Use start >= 0 and a duration between 0 and 120 seconds.')
    output = ROOT / 'docs/images'
    output.mkdir(parents=True, exist_ok=True)
    if args.screenshot or args.record:
        if sys.platform != 'darwin':
            parser.error('Desktop capture requires macOS; use --video for existing recordings.')
        print('Use a demo collection and keep only the Noctua window in the selected region.', flush=True)
        if args.screenshot:
            screenshots = ROOT / 'target/note-qol-recording/screenshots'
            screenshots.mkdir(parents=True, exist_ok=True)
            destination = screenshots / f'{args.scene}.png'
            run(['/usr/sbin/screencapture', '-i', '-w', '-o', '-x', str(destination)])
            if not destination.is_file():
                raise RuntimeError('Capture cancelled or unavailable; no screenshot was created.')
        else:
            if not shutil.which('ffmpeg'):
                raise RuntimeError('FFmpeg is required before recording.')
            raw = ROOT / 'target/note-qol-recording'
            raw.mkdir(parents=True, exist_ok=True)
            source = raw / f'{args.scene}.mov'
            run(['/usr/sbin/screencapture', '-i', '-v', '-k', '-V', str(args.seconds), str(source)])
            if not source.is_file():
                raise RuntimeError('Capture cancelled or unavailable; no recording was created.')
            encode(source, output / f'note-qol-{args.scene}.gif', args.start, args.seconds)
    else:
        source = args.video.expanduser().resolve()
        if not source.is_file():
            parser.error(f'Recording does not exist: {source}')
        encode(source, output / f'note-qol-{args.scene}.gif', args.start, args.seconds)
    if args.screenshot:
        print(f'Saved still capture: {destination}')
        return
    embed(args.scene)
    print(f'Updated docs/pr-note-qol.md: {args.scene}')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
