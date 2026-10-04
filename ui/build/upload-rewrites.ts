import type { Rewrite } from "./feature-rewrites"

// Joins lines into a block that ends with a newline, so removing it removes whole lines.
const lines = (...l: string[]) => l.join("\n") + "\n"

// Rewrites that remove file uploads from opencode v1.18.29 (vendor/opencode). Paths are
// relative to vendor/opencode/packages. @mentions (file: references) keep working.
export const uploadRewrites: Rewrite[] = [
  // v1 composer: the file.attach command (mod+u)
  {
    file: "app/src/components/prompt-input.tsx",
    search: lines(
      "    {",
      "      id: \"file.attach\",",
      "      title: language.t(\"prompt.action.attachFile\"),",
      "      category: language.t(\"command.category.file\"),",
      "      keybind: \"mod+u\",",
      "      disabled: store.mode !== \"normal\",",
      "      onSelect: pick,",
      "    },",
    ),
    replace: "",
  },
  // v1 composer: the unused hidden file input
  {
    file: "app/src/components/prompt-input.tsx",
    search: lines(
      "  const fileAttachmentInput = () => (",
      "    <input",
      "      ref={(el) => (fileInputRef = el)}",
      "      type=\"file\"",
      "      multiple",
      "      accept={ACCEPTED_FILE_TYPES.join(\",\")}",
      "      class=\"hidden\"",
      "      onChange={(e) => {",
      "        const list = e.currentTarget.files",
      "        if (list) void addAttachments(Array.from(list))",
      "        e.currentTarget.value = \"\"",
      "      }}",
      "    />",
      "  )",
      "",
    ),
    replace: "",
  },
  // v1 composer: the hidden file input
  {
    file: "app/src/components/prompt-input.tsx",
    search: lines(
      "            <input",
      "              ref={fileInputRef}",
      "              type=\"file\"",
      "              multiple",
      "              accept={ACCEPTED_FILE_TYPES.join(\",\")}",
      "              class=\"hidden\"",
      "              onChange={(e) => {",
      "                const list = e.currentTarget.files",
      "                if (list) void addAttachments(Array.from(list))",
      "                e.currentTarget.value = \"\"",
      "              }}",
      "            />",
      "",
    ),
    replace: "",
  },
  // v1 composer: the attach button
  {
    file: "app/src/components/prompt-input.tsx",
    search: lines(
      "              <TooltipKeybind",
      "                placement=\"top\"",
      "                title={language.t(\"prompt.action.attachFile\")}",
      "                keybind={command.keybind(\"file.attach\")}",
      "              >",
      "                <Button",
      "                  data-action=\"prompt-attach\"",
      "                  type=\"button\"",
      "                  variant=\"ghost\"",
      "                  class=\"size-8 p-0\"",
      "                  style={buttons()}",
      "                  onClick={pick}",
      "                  disabled={store.mode !== \"normal\"}",
      "                  tabIndex={store.mode === \"normal\" ? undefined : -1}",
      "                  aria-label={language.t(\"prompt.action.attachFile\")}",
      "                >",
      "                  <Icon name=\"plus\" class=\"size-4.5\" />",
      "                </Button>",
      "              </TooltipKeybind>",
    ),
    replace: "",
  },
  // v1 composer: the attach button no longer exists, so the mousedown guard only needs
  // to ignore clicks on the submit button
  {
    file: "app/src/components/prompt-input.tsx",
    search: "target.closest('[data-action=\"prompt-attach\"], [data-action=\"prompt-submit\"]')",
    replace: "target.closest('[data-action=\"prompt-submit\"]')",
  },
  // v1 paste, drop and picker: every file goes through add(), which now refuses it
  {
    file: "app/src/components/prompt-input/attachments.ts",
    search: lines(
      "  const add = async (file: File, toast = true, target = capture()) => {",
      "    if (!target) return false",
    ),
    replace: lines(
      "  const add = async (file: File, toast = true, target = capture()) => {",
      "    return false",
    ),
  },
  // v1 drop: no image drop overlay for dragged files
  {
    file: "app/src/components/prompt-input/attachments.ts",
    search: lines(
      "    if (hasFiles) {",
      "      input.setDraggingType(\"image\")",
      "    } else if (hasText) {",
    ),
    replace: lines(
      "    if (hasText) {",
    ),
  },
  // v2 composer: no attachments config disables attach, paste and drop
  {
    file: "app/src/components/prompt-input-v2.tsx",
    search: lines(
      "    attachments: {",
      "      picker: platform.openAttachmentPickerDialog,",
      "      directory: () => sdk().directory,",
      "      isDialogActive: () => !!dialog.active,",
      "      warn: () =>",
      "        showToast({",
      "          title: language.t(\"prompt.toast.pasteUnsupported.title\"),",
      "          description: language.t(\"prompt.toast.pasteUnsupported.description\"),",
      "        }),",
      "      duplicate: () => showToast({ title: language.t(\"prompt.toast.attachmentDuplicate.title\") }),",
      "      onError: (error) =>",
      "        showToast({",
      "          variant: \"error\",",
      "          title: language.t(\"common.requestFailed\"),",
      "          description: error instanceof Error ? error.message : String(error),",
      "        }),",
      "      readClipboardImage: platform.readClipboardImage,",
      "      getPathForFile: platform.getPathForFile,",
      "      store: platform.draftStore?.putBlob,",
      "    },",
    ),
    replace: "",
  },
  // v2 composer: the file.attach command (mod+u)
  {
    file: "app/src/components/prompt-input-v2.tsx",
    search: lines(
      "    {",
      "      id: \"file.attach\",",
      "      title: language.t(\"prompt.action.attachFile\"),",
      "      category: language.t(\"command.category.file\"),",
      "      keybind: \"mod+u\",",
      "      disabled: controller.state.mode !== \"normal\",",
      "      onSelect: () => controller.attach(),",
      "    },",
    ),
    replace: "",
  },
  // v2 controls: the hidden file input
  {
    file: "session-ui/src/v2/components/prompt-input/index.tsx",
    search: lines(
      "      <input",
      "        ref={props.controller.setFileInput}",
      "        type=\"file\"",
      "        multiple",
      "        accept=\"image/png,image/jpeg,image/gif,image/webp,application/pdf,text/*,application/json,application/ld+json,application/toml,application/x-toml,application/x-yaml,application/xml,application/yaml,.c,.cc,.cjs,.conf,.cpp,.css,.csv,.cts,.env,.go,.gql,.graphql,.h,.hh,.hpp,.htm,.html,.ini,.java,.js,.json,.jsx,.log,.md,.mdx,.mjs,.mts,.py,.rb,.rs,.sass,.scss,.sh,.sql,.toml,.ts,.tsx,.txt,.xml,.yaml,.yml,.zsh\"",
      "        class=\"hidden\"",
      "        onChange={(event) => {",
      "          const list = event.currentTarget.files",
      "          if (list) props.controller.addAttachments(Array.from(list))",
      "          event.currentTarget.value = \"\"",
      "        }}",
      "      />",
    ),
    replace: "",
  },
  // v2 controls: the "Images and files" item of the + menu
  {
    file: "session-ui/src/v2/components/prompt-input/index.tsx",
    search: lines(
      "            <MenuV2.Item onSelect={props.onAttach} shortcut={props.attachShortcut}>",
      "              {props.attachLabel}",
      "            </MenuV2.Item>",
      "            <MenuV2.Separator />",
    ),
    replace: "",
  },
  // project icon (both edit dialogs): dropped or picked files are ignored
  {
    file: "app/src/components/edit-project.ts",
    search: lines(
      "  function selectFile(file: File) {",
      "    if (!file.type.startsWith(\"image/\")) return",
    ),
    replace: lines(
      "  function selectFile(file: File) {",
      "    return",
    ),
  },
  // project icon: clicking the icon no longer opens the file picker
  {
    file: "app/src/components/edit-project.ts",
    search: lines(
      "    iconInput?.click()",
    ),
    replace: "",
  },
]
