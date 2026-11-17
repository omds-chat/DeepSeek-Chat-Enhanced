import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { setupTheme } from './app/theme.js'
import { ensureKatex } from './services/markdown/katex.js'
import { installPluginEngine } from './components/dsc-plugin-engine/index.js'
import './app/theme.css'
import './app/global.css'

ensureKatex()
setupTheme()
installPluginEngine()

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
