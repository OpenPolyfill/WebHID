this.webhidNativeTheme = class extends ExtensionAPI {
  getAPI() {
    return {
      webhidNativeTheme: {
        getTokens: async () => {
          const window = Services.wm.getMostRecentWindow('navigator:browser')
          if (!window) return {}

          const style = window.getComputedStyle(window.document.documentElement)
          const read = (name) => style.getPropertyValue(name).trim()
          const zenAccent = read('--zen-primary-color')
          const accent = zenAccent || read('--color-accent-primary')
          const background =
            read('--zen-main-browser-background') || read('--in-content-page-background')
          const hex = background.match(/^#([\da-f]{6})$/i)?.[1]
          const channels = hex?.match(/.{2}/g).map((channel) => parseInt(channel, 16))
          const scheme = channels
            ? channels[0] * 0.299 + channels[1] * 0.587 + channels[2] * 0.114 < 128
              ? 'dark'
              : 'light'
            : ''

          return {
            accent,
            accentHover: zenAccent ? '' : read('--color-accent-primary-hover'),
            accentActive: zenAccent ? '' : read('--color-accent-primary-active'),
            background,
            foreground: read('--zen-colors-primary-foreground') || read('--in-content-page-color'),
            surface: read('--zen-colors-tertiary') || read('--background-color-box'),
            border: read('--zen-colors-border') || read('--in-content-border-color'),
            focus: read('--focus-outline-color'),
            scheme
          }
        }
      }
    }
  }
}
