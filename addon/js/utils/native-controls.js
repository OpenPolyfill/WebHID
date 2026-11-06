;(function () {
  /** Firefox-styled switch backed by an ordinary checkbox. */
  class WebhidToggle extends HTMLElement {
    /** Creates the switch button in its shadow tree. */
    constructor() {
      super()
      const shadow = this.attachShadow({ mode: 'open' })
      shadow.innerHTML = `
        <link rel="stylesheet" href="chrome://global/content/elements/moz-toggle.css">
        <button type="button" class="toggle-button" part="button" aria-pressed="false"></button>
      `
      this.button = shadow.querySelector('button')
      this.button.addEventListener('click', () => {
        this.querySelector('input[type="checkbox"]').click()
      })
      this.addEventListener('change', () => this.sync())
    }

    /** Initializes checkbox accessibility and button state. */
    connectedCallback() {
      const input = this.querySelector('input[type="checkbox"]')
      input.tabIndex = -1
      input.setAttribute('aria-hidden', 'true')
      this.sync()
    }

    /** Synchronizes the visible switch with the checkbox state. */
    sync() {
      const input = this.querySelector('input[type="checkbox"]')
      this.button.setAttribute('aria-pressed', String(input.checked))
      this.button.disabled = input.disabled
      const labelledBy = input.getAttribute('aria-labelledby')
      const label =
        input.getAttribute('aria-label') || document.getElementById(labelledBy)?.textContent
      if (label) this.button.setAttribute('aria-label', label.trim())
    }
  }

  /** Groups native radio inputs under one accessible label. */
  class WebhidRadioGroup extends HTMLElement {
    /** Exposes native radio-group semantics. */
    connectedCallback() {
      this.setAttribute('role', 'radiogroup')
    }
  }

  customElements.define('webhid-toggle', WebhidToggle)
  customElements.define('webhid-radio-group', WebhidRadioGroup)
})()
