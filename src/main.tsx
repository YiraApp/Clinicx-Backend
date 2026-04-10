import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './i18n'
import App from './App'
import { Provider } from 'react-redux'
import { store } from './store'

const container = document.getElementById('root')

if (container) {
  createRoot(container).render(
    <Provider store={store}>
      <App />
    </Provider>
  )
}
