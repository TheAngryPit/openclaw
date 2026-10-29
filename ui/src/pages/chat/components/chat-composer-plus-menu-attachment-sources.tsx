import { Icon } from "../../../components/solid/icon.tsx";
import type { MenuEntry } from "../../../components/solid/menu.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import type { ChatComposerPlusMenuContentProps } from "./chat-composer-plus-menu.types.ts";

export function attachmentSourceGroup(
  menu: ChatComposerPlusMenuContentProps,
  nativeSourceMenu: boolean,
  nativeVideoCapture: boolean,
): MenuEntry {
  const sources: MenuEntry[] = [];
  const mediaOption = menu.attachments.imagesOnly
    ? (["photo", "image", t("chat.composer.attachPhoto")] as const)
    : (["media", "image", t("chat.composer.attachMedia")] as const);
  for (const [id, icon, label] of nativeSourceMenu
    ? ([["file", "paperclip", t("chat.composer.attach")]] as const)
    : ([
        ["camera", "camera", t("chat.composer.cameraInput")],
        ...(nativeVideoCapture
          ? ([["camera-video", "camera", t("chat.composer.recordVideo")]] as const)
          : []),
        mediaOption,
        // Image-only composers keep the single picker's file input, filtered to images.
        ...(menu.attachments.imagesOnly
          ? []
          : ([["file", "paperclip", t("chat.composer.attachFileOption")]] as const)),
      ] as const)) {
    sources.push({
      id,
      label,
      class: nativeSourceMenu
        ? "agent-chat__attach-menu-option agent-chat__capability-menu-item"
        : "agent-chat__attach-menu-option",
      icon: <Icon name={icon} />,
    });
  }
  return {
    kind: "group",
    id: "attachment-sources",
    class: sources.length === 1 ? undefined : "agent-chat__attachment-sources",
    items: sources,
  };
}
