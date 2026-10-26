# Bundled pdfLaTeX and BibTeX

Noctua redistributes a subset of TeX Live 2026 from TinyTeX v2026.10:
https://github.com/rstudio/tinytex-releases/releases/tag/v2026.10

The build script verifies the official release archive's SHA-256 digest and adds
JMLR/algorithm2e/SyncTeX dependencies from the fixed 2026-10-01 TeX Live repository:
https://texlive.info/tlnet-archive/2026/10/01/tlnet

The distribution's LICENSE.TL, LICENSE.CTAN, package metadata in tlpkg, and
package documentation/license files in texmf-dist are retained. Individual
packages and fonts have their own licenses; this is not a relicensing under
Noctua's license. Unused compiler executables are omitted and selected executable
symlinks are materialized as regular files for portable application packaging.

TeX Live information, licensing, and source availability:
https://tug.org/texlive/copying.html
https://tug.org/texlive/svn/
