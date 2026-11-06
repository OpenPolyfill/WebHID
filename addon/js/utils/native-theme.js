;(function () {
  const webhid = globalThis.webhid

  /**
   * Applies the optional browser-chrome palette to an extension page or picker host.
   * @param {HTMLElement} [target]
   * @returns {Promise<void>}
   */
  async function syncNativeTheme(target = document.documentElement) {
    let colors
    try {
      colors = await browser.runtime.sendMessage({ action: 'getNativeThemeTokens' })
    } catch {
      return
    }
    if (!colors) return

    const properties = {
      '--color-accent-primary': colors.accent,
      '--color-accent-primary-hover': colors.accent
        ? colors.accentHover ||
          'color-mix(in srgb, var(--color-accent-primary) 85%, var(--in-content-page-color))'
        : '',
      '--color-accent-primary-active': colors.accent
        ? colors.accentActive ||
          'color-mix(in srgb, var(--color-accent-primary) 70%, var(--in-content-page-color))'
        : '',
      '--in-content-page-background': colors.background,
      '--in-content-page-color': colors.foreground,
      '--background-color-box': colors.surface,
      '--in-content-border-color': colors.border,
      '--focus-outline-color': colors.focus,
      '--bg': colors.background,
      '--text': colors.foreground,
      '--accent': colors.accent,
      '--surface-raised': colors.surface,
      '--border-subtle': colors.border,
      '--border-light': colors.border,
      '--border-default': colors.border,
      '--border-strong': colors.border,
      '--accent-hover': colors.accentHover
    }
    for (const [name, value] of Object.entries(properties)) {
      if (value) target.style.setProperty(name, value)
    }
    if (colors.scheme) target.style.colorScheme = colors.scheme
  }

  webhid.export('syncNativeTheme', syncNativeTheme)
  if (location.protocol === 'moz-extension:') {
    syncNativeTheme()
    window.addEventListener('focus', () => syncNativeTheme())
  }
})()
