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
    <svg width="44" height="44" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm-3 8V7a3 3 0 1 1 6 0v3H9Z" />
    </svg>
    <div class="title">{t("Hollr ist gesperrt")}</div>
    <button class="btn primary" bind:this={button} disabled={appLock.authenticating} onclick={unlock}>
      {t("Mit {name} entsperren", { name: biometryName() })}
    </button>
  </div>
{/if}

<style>
  /* opaque: nothing of the app may be readable behind it */
  .lock { position: fixed; inset: 0; z-index: 1000; background: var(--bg); display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 18px; user-select: none; -webkit-user-select: none; }
  svg { color: var(--accent); }
  .title { font-size: 18px; font-weight: 600; }
  .btn { padding: 8px 18px; }
</style>
