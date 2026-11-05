<script lang="ts">
  // App lock overlay (iOS AppLockModifier): covers the whole app while locked. Locks on start and when the window
  // was away (unfocused / hidden) for more than GRACE_MS, then asks for Touch ID / the password right away.
  // Mounted once by the shell, after everything else.
  import { onMount, tick } from "svelte";
  import { fade } from "svelte/transition";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { t } from "$lib/i18n";
  import { settings } from "$lib/settings.svelte";
  import { appLock, biometryName, GRACE_MS, loadSupport, unlock } from "$lib/applock.svelte";

  const shown = $derived(settings.appLock && appLock.locked);
  let overlay = $state<HTMLDivElement>();
  let button = $state<HTMLButtonElement>();

  /** when the window lost the focus (our own system prompt does not count) */
  let awaySince: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const lock = () => settings.appLock && (appLock.locked = true);

  function away() {
    // the Touch ID / password prompt takes the focus itself
    if (!settings.appLock || appLock.authenticating || awaySince !== undefined) return;
    awaySince = Date.now();
    clearTimeout(timer);
    // a hidden / minimised window locks as soon as the grace is over, so it comes back covered
    timer = setTimeout(() => document.visibilityState === "hidden" && lock(), GRACE_MS + 50);
  }

  function back() {
    clearTimeout(timer);
    const long = awaySince !== undefined && Date.now() - awaySince > GRACE_MS;
    awaySince = undefined;
    if (!long || !settings.appLock) return;
    lock();
    unlock();
  }

  function onVisibility() {
    if (document.visibilityState !== "hidden") return;
    away();
    if (awaySince !== undefined && Date.now() - awaySince > GRACE_MS) lock();
  }

  /** while locked the keyboard must not reach the app behind (shortcuts, a focused text field) */
  function guard(e: KeyboardEvent) {
    if (!shown) return;
    if (e.key !== "Tab" && overlay?.contains(e.target as Node)) return;
    e.preventDefault();
    e.stopPropagation();
    button?.focus();
  }

  $effect(() => {
    if (!shown) return;
    (document.activeElement as HTMLElement | null)?.blur();
    tick().then(() => button?.focus());
  });

  onMount(() => {
    loadSupport();
    if (shown) unlock();
    // the dev bridge has no Tauri event internals: wiring or unwiring may throw there
    let unlisten: (() => void) | undefined;
    try {
      getCurrentWindow()
        .onFocusChanged(({ payload: focused }) => (focused ? back() : away()))
        .then((off) => (unlisten = off))
        .catch(() => {});
    } catch {}
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimeout(timer);
      try {
        unlisten?.();
      } catch {}
      document.removeEventListener("visibilitychange", onVisibility);
    };
  });
</script>

<svelte:window onkeydowncapture={guard} />

{#if shown}
  <div class="lock" bind:this={overlay} role="dialog" aria-modal="true" aria-label={t("Hollr ist gesperrt")} out:fade={{ duration: 150 }}>
    <span class="ico" aria-hidden="true">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </svg>
    </span>
    <div class="title">{t("Hollr ist gesperrt")}</div>
    <div class="text">{t("Die Agents arbeiten auf dem Server weiter.")}</div>
    <button class="btn primary" bind:this={button} disabled={appLock.authenticating} onclick={unlock}>
      {t("Mit {name} entsperren", { name: biometryName() })}
    </button>
  </div>
{/if}

<style>
  /* opaque: nothing of the app may be readable behind it */
  .lock { position: fixed; inset: 0; z-index: 1000; background: var(--bg); display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 16px; user-select: none; -webkit-user-select: none; }
  .ico { width: 64px; height: 64px; border-radius: 50%; display: grid; place-items: center; background: var(--card); border: 1px solid var(--border); color: var(--fg); }
  .title { font-size: 18px; font-weight: 600; margin-top: -4px; }
  .text { font-size: 13px; color: var(--muted); margin-top: -10px; }
  .btn { padding: 8px 18px; }
</style>
