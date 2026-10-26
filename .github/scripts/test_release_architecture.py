"""Exercise the workflow's architecture selection against current and old tags."""

from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest


WORKFLOW = Path(__file__).parents[1] / "workflows/release.yml"


class ReleaseArchitectureTests(unittest.TestCase):
    def resolve(self, workflow):
        # Execute the production inline command, using an isolated tagged checkout.
        command = next(line.strip() for line in WORKFLOW.read_text().splitlines()
                       if line.strip().startswith('python3 -c "from pathlib import Path; lines'))
        args = shlex.split(command.split(' >> "$GITHUB_OUTPUT"')[0])
        args[0] = sys.executable
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / ".github/workflows/release.yml"
            target.parent.mkdir(parents=True)
            target.write_text(workflow)
            return subprocess.check_output(args, cwd=directory, text=True).strip()

    def test_current_tag_selects_apple_silicon(self):
        self.assertEqual(self.resolve(WORKFLOW.read_text()), "arch=aarch64")

    def test_legacy_tag_retains_universal_build(self):
        self.assertEqual(self.resolve("jobs:\n  build:\n    args: --target universal-apple-darwin\n"),
                         "arch=universal")

    def test_comment_does_not_enable_intel_build(self):
        self.assertEqual(self.resolve("# args: --target universal-apple-darwin\n"), "arch=aarch64")


if __name__ == "__main__":
    unittest.main()
