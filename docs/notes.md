# Notes

[Documentation](README.md) · [Project README](../README.md)

## Write in a collection

Select a collection, switch to **Notes**, and choose **New note**. Notes combine
text, drawing, and media blocks and save automatically. Click text to edit its
source with a live preview; click away to finish. Hover between blocks to insert
content. The **?** beside the title opens the in-app syntax and editing guide.

## LaTeX, citations, and links

Notes support a LaTeX subset: inline and display math, numbered equations,
sections, lists, theorem-like environments, proofs, and custom commands.
For example:

```latex
\section{Main idea}
The state evolves as $x_{t+1} = f(x_t, u_t)$.
\begin{equation}\label{eq:cost}
J = \sum_{t=0}^{T} c(x_t, u_t)
\end{equation}
We minimize the cost in \eqref{eq:cost}.
```

Use `\label`, `\ref`, and `\eqref` to link within a note. Type `\cite{` to pick
a paper from the collection, or `[[` to link another note. The title's gear
opens a preamble for shared commands and page layout.

This is not a full TeX installation: arbitrary packages and TikZ are unsupported.
Chat Markdown and Mermaid use a separate renderer.

## Drawings and media

Add a drawing pad for handwritten notes. Its **TeX** button uses the selected
assistant to insert a LaTeX transcription below while preserving the drawing.

The [transcription prompt](../src/prompts/handwriting.md) specifies supported
LaTeX and how diagrams are represented. See
[AI prompts](assistant.md#dedicated-ai-features) for the task's input and output.

Paste or drop images and videos, or choose **Image / Video** between blocks.
Media supports captions, labels, and side-by-side layouts. A YouTube URL alone
on a source line embeds a player. Local video uses Noctua's `\includevideo`
command; playback is not standard LaTeX export behavior.

## Assistant edits

The assistant can read notes, inspect attached images, and propose or apply
text-block edits. Drawing transcription uses the pad's TeX control; chat image
tools do not read drawing strokes or videos. Whole-note management, preamble
changes, media insertion, and layout controls remain UI actions.

Use **Suggest** to review edits, **Plan** for read-only discussion, or **Direct**
for immediate changes with note-edit undo. Attach a note with @ in chat or select
rendered text and choose **Add to chat**. See [Research assistant](assistant.md).
