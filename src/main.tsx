import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// No StrictMode: the audio engine is a page-level singleton and must not be double-initialised.
createRoot(document.getElementById('root')!).render(<App />)
