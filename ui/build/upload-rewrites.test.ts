// @vitest-environment node
import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { applyRewrites } from "./feature-rewrites"
import { uploadRewrites } from "./upload-rewrites"

const packages = fileURLToPath(new URL("../../vendor/opencode/packages", import.meta.url))
const rewritten = (file: string) =>
  applyRewrites(fs.readFileSync(path.join(packages, file), "utf8"), file, uploadRewrites)

describe.skipIf(!fs.existsSync(path.join(packages, "app")))("upload rewrites on the pinned opencode", () => {
  it("v1 composer has no file input, attach button or attach command", () => {
    const code = rewritten("app/src/components/prompt-input.tsx")
    expect(code).not.toContain('type="file"')
    expect(code).not.toContain('data-action="prompt-attach"')
    expect(code).not.toContain('id: "file.attach"')
  })

  it("v1 paste, drop and picker refuse files; @mention drops stay", () => {
    const code = rewritten("app/src/components/prompt-input/attachments.ts")
    expect(code).toContain("const add = async (file: File, toast = true, target = capture()) => {\n    return false\n")
    expect(code).not.toContain('input.setDraggingType("image")')
    expect(code).toContain('input.addPart({ type: "file", path: filePath')
  })

  it("v2 composer has no attachments config or attach command", () => {
    const code = rewritten("app/src/components/prompt-input-v2.tsx")
    expect(code).not.toContain("attachments: {")
    expect(code).not.toContain('id: "file.attach"')
  })

  it("v2 controls have no file input or attachments menu item", () => {
    const code = rewritten("session-ui/src/v2/components/prompt-input/index.tsx")
    expect(code).not.toContain('type="file"')
    expect(code).not.toContain("{props.attachLabel}")
    expect(code).toContain("<MenuV2.Item onSelect={props.onCommands}")
  })

  it("the project icon ignores files and never opens the picker", () => {
    const code = rewritten("app/src/components/edit-project.ts")
    expect(code).toContain("function selectFile(file: File) {\n    return\n")
    expect(code).not.toContain("iconInput?.click()")
  })
})
