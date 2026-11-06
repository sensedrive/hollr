import type { Exec } from "./herdr";

/**
 * Closes a session's pane – never its space. herdr closes a workspace together with its last pane, and refuses
 * outright when that workspace is the primary of a worktree group (`confirmation_required`: "closing this pane
 * would close a worktree group"). A space only closes through „Space schließen“ (`spaces close`): when `pane` is
 * the workspace's last one, a fresh terminal tab in the space's folder takes over first – the space looks as it
 * does right after „Neuer Space“. A failed close takes that terminal back and throws herdr's error.
 * Returns the stand-in terminal's pane, if one was needed.
 */
export async function closePane(exec: Exec, pane: string): Promise<{ placeholder?: string }> {
  const { pane: info } = (await exec(["pane", "get", pane])) as {
    pane?: { workspace_id?: string; cwd?: string };
  };
  const ws = info?.workspace_id;
  let placeholder: string | undefined;
  if (ws) {
    const { workspace } = (await exec(["workspace", "get", ws])) as {
      workspace?: { pane_count?: number; worktree?: { checkout_path?: string } };
    };
    if (workspace?.pane_count === 1) {
      const args = ["tab", "create", "--workspace", ws, "--no-focus"];
      // the space's folder (spaces.ts: checkout path, else its panes' folder)
      const cwd = workspace.worktree?.checkout_path || info?.cwd;
      if (cwd) args.push("--cwd", cwd);
      const created = (await exec(args)) as { root_pane?: { pane_id?: string } };
      placeholder = created.root_pane?.pane_id;
    }
  }
  try {
    await exec(["pane", "close", pane]);
  } catch (err) {
    if (placeholder) await exec(["pane", "close", placeholder]).catch(() => {});
    throw err;
  }
  return placeholder ? { placeholder } : {};
}
