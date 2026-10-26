import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import { requestConfirmDialog } from "../confirmDialog";
import {
  type ComposerThreadTarget,
  composerDraftHasUserContent,
  resolveComposerDraftKey,
  useComposerDraftStore,
} from "../composerDraftStore";
import { showThreadUndoNotice } from "../hooks/showThreadUndoNotice";
import * as ThreadUndo from "../hooks/threadUndo";
import { releaseDraftAttachments } from "./attachmentUploadQueue";

export function discardComposerDraft(target: ComposerThreadTarget): void {
  const store = useComposerDraftStore.getState();
  const key = resolveComposerDraftKey(store, target);
  const draft = key === null ? undefined : store.draftsByThreadKey[key];
  if (key === null || !draft) return;
  const session = store.draftThreadsByThreadKey[key];
  const logicalProjectKeys = Object.entries(store.logicalProjectDraftThreadKeyByLogicalProjectKey)
    .filter(([, draftKey]) => draftKey === key)
    .map(([logicalProjectKey]) => logicalProjectKey);
  const discardsSession = typeof target === "string";

  const claim = ThreadUndo.begin("discard", key);
  if (discardsSession) {
    store.clearDraftThread(target);
  } else {
    store.clearComposerContent(target);
  }

  showThreadUndoNotice({
    action: "Discarded",
    claim,
    failureTitle: "Failed to restore draft",
    undo: async () => {
      const current = useComposerDraftStore.getState().draftsByThreadKey[key];
      if (current && composerDraftHasUserContent(current)) {
        releaseDraftAttachments([...draft.images, ...draft.files]);
        return AsyncResult.failure(Cause.fail(new Error("The draft has new content.")));
      }
      useComposerDraftStore.setState((state) => {
        const logicalProjectDraftThreadKeyByLogicalProjectKey = {
          ...state.logicalProjectDraftThreadKeyByLogicalProjectKey,
        };
        for (const logicalProjectKey of logicalProjectKeys) {
          logicalProjectDraftThreadKeyByLogicalProjectKey[logicalProjectKey] ??= key;
        }
        return {
          draftsByThreadKey: {
            ...state.draftsByThreadKey,
            [key]: discardsSession
              ? {
                  ...draft,
                  images: draft.images.map((image) =>
                    image.previewUrl.startsWith("blob:")
                      ? { ...image, previewUrl: URL.createObjectURL(image.file) }
                      : image,
                  ),
                }
              : draft,
          },
          draftThreadsByThreadKey: session
            ? { ...state.draftThreadsByThreadKey, [key]: session }
            : state.draftThreadsByThreadKey,
          logicalProjectDraftThreadKeyByLogicalProjectKey,
        };
      });
      return AsyncResult.success(undefined);
    },
    commit: () => releaseDraftAttachments([...draft.images, ...draft.files]),
  });
}

const discardDraftConfirmation =
  "Discard this draft?\nYour unsent text and attachments will be deleted. You can undo it right after.";

// A second click while the first dialog is opening would queue a second dialog for the same draft.
const pendingDiscardConfirmations = new Set<string>();

function discardConfirmationKey(target: ComposerThreadTarget): string {
  return typeof target === "string"
    ? `draft:${target}`
    : `thread:${target.environmentId}:${target.threadId}`;
}

export async function confirmDiscardComposerDraft(target: ComposerThreadTarget): Promise<void> {
  const pendingKey = discardConfirmationKey(target);
  if (pendingDiscardConfirmations.has(pendingKey)) return;

  const store = useComposerDraftStore.getState();
  const key = resolveComposerDraftKey(store, target);
  const draft = key === null ? undefined : store.draftsByThreadKey[key];
  if (!draft || !composerDraftHasUserContent(draft)) {
    // An emptied draft row still needs its X to remove the row; a thread has nothing to lose.
    if (typeof target === "string") discardComposerDraft(target);
    return;
  }

  pendingDiscardConfirmations.add(pendingKey);
  try {
    const confirmed =
      (await requestConfirmDialog(discardDraftConfirmation, { variant: "destructive" })) ??
      (typeof window === "undefined" ? false : window.confirm(discardDraftConfirmation));
    if (confirmed) discardComposerDraft(target);
  } finally {
    pendingDiscardConfirmations.delete(pendingKey);
  }
}
