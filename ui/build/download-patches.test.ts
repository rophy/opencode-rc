// @vitest-environment node
import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { applyPatches, readPatches } from "./vendor-patches"

const opencode = fileURLToPath(new URL("../../vendor/opencode-v1", import.meta.url))
const patchDir = fileURLToPath(new URL("../../vendor/patches/v1/downloads", import.meta.url))
const patched = (file: string) => applyPatches(fs.readFileSync(path.join(opencode, file), "utf8"), file, readPatches(patchDir))

describe.skipIf(!fs.existsSync(path.join(opencode, "packages/app")))("download patches on the pinned opencode", () => {
  it("the file.open command is disabled: no mod+p, no /open", () => {
    const code = patched("packages/app/src/pages/session/use-session-commands.tsx")
    expect(code).toMatch(/id: "file.open",[^]*?disabled: true,\n\s+hidden: true,/)
    expect(code).not.toContain('keybind: "mod+p"')
    expect(code).not.toContain('slash: "open"')
  })

  it("the session header has no file search button", () => {
    const code = patched("packages/app/src/components/session/session-header.tsx")
    expect(code).toContain("const search = () => false")
  })

  it("diffs have no view-file action", () => {
    const code = patched("packages/app/src/pages/session.tsx")
    expect(code).not.toContain("onViewFile")
  })

  it("the side panel has no + button or open-file browser, and tree clicks open nothing", () => {
    const code = patched("packages/app/src/pages/session/session-side-panel.tsx")
    expect(code).not.toContain('icon="plus-small"')
    expect(code).not.toContain("openFileBrowser")
    expect(code).toContain("const previewTab = (_value: string) => {}")
    const helpers = patched("packages/app/src/pages/session/helpers.ts")
    expect(helpers).toMatch(/createOpenSessionFileTab[^]*?return \(_value: string\) => \{\}/)
  })

  it("the command palette neither lists, searches nor opens files", () => {
    const palette = patched("packages/app/src/components/command-palette.ts")
    expect(palette).toContain("return (_path: string) => {}")
    expect(palette).not.toContain("view().reviewPanel.open()")
    expect(palette.match(/if \(true as boolean\) return \[\]/g)).toHaveLength(2)
    expect(patched("packages/app/src/components/dialog-select-file.tsx")).not.toContain("searchFiles(")
    expect(patched("packages/app/src/components/dialog-command-palette-v2.tsx")).not.toContain("searchFiles(")
  })

  it("the composers offer no files or directories after @, only agents and MCP resources", () => {
    const v1 = patched("packages/app/src/components/prompt-input.tsx")
    expect(v1).toContain("items: async () => [...agentList(), ...mcpResourceList()],")
    expect(v1).not.toContain("searchFilesAndDirectories(")
    const v2 = patched("packages/app/src/components/prompt-input-v2.tsx")
    expect(v2).toContain("searchContextFiles: async () => [],")
    expect(v2).not.toContain("searchFilesAndDirectories(")
    expect(v2).not.toMatch(/\.\.\.references\(\),|\.\.\.recent\(\)\.map/)
    // What @ must still offer: agents and MCP resources.
    expect(v2).toContain("id: `agent:${agent.name}`,")
    expect(v2).toContain("    ...resources(),\n")
  })

  it("files cannot be dragged from the tree into the composer", () => {
    const code = patched("packages/app/src/components/file-tree.tsx")
    expect(code).toContain("draggable={false}")
    expect(code).not.toContain("draggable={local.draggable}")
  })

  it("prompts carry no file: parts: only MCP resources, and comments as their note", () => {
    const code = patched("packages/app/src/components/prompt-input/build-request-parts.ts")
    expect(code).toContain('.filter((attachment) => attachment.source?.type === "resource")')
    expect(code).not.toContain("filePart")
    expect(code).not.toContain("parseCommentMentions(comment)")
    expect(code.match(/file:\/\/\$\{encodeFilePath/g)).toHaveLength(2)
    // Comment notes and pasted images are still sent.
    expect(code).toContain("text: formatCommentNote({ path: item.path, selection: item.selection, comment }),")
    expect(code).toContain("const images = input.images.map((attachment) => {")
    expect(code).toContain("requestParts.push(...files, ...context, ...agents, ...images)")
  })
})
