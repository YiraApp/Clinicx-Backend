"use client"

import type React from "react"
import { createContext, useContext, useState, useEffect } from "react"
import { useTranslation } from "react-i18next"

export type LanguageCode = "en" | "hi" | "te" | "ta" | "kn"

export interface Language {
  code: LanguageCode
  name: string
  nativeName: string
}

export const INDIAN_LANGUAGES: Language[] = [
  { code: "en", name: "English", nativeName: "English" },
  { code: "hi", name: "Hindi", nativeName: "हिन्दी" },
  { code: "te", name: "Telugu", nativeName: "తెలుగు" },
  { code: "ta", name: "Tamil", nativeName: "தமிழ்" },
  { code: "kn", name: "Kannada", nativeName: "ಕನ್ನಡ" },
]

interface AppSettings {
  language: LanguageCode
  theme: "light" | "dark" | "system"
  accessibility: {
    highContrast: boolean
    largeText: boolean
    reduceMotion: boolean
  }
  sound: boolean
}

interface LanguageContextType {
  language: LanguageCode
  theme: "light" | "dark" | "system"
  accessibility: AppSettings["accessibility"]
  sound: boolean
  setLanguage: (code: LanguageCode) => void
  setTheme: (theme: "light" | "dark" | "system") => void
  setAccessibility: (access: Partial<AppSettings["accessibility"]>) => void
  setSound: (enabled: boolean) => void
  t: (key: string) => string
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined)

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const { t, i18n } = useTranslation()
  const [settings, setSettings] = useState<AppSettings>({
    language: (i18n.language as LanguageCode) || "en",
    theme: "system",
    accessibility: {
      highContrast: false,
      largeText: false,
      reduceMotion: false,
    },
    sound: true,
  })

  useEffect(() => {
    const savedPrefs = localStorage.getItem("yira-user-preferences")
    if (savedPrefs) {
      try {
        const parsed = JSON.parse(savedPrefs)
        setSettings(prev => ({
          ...prev,
          language: parsed.language || (i18n.language as LanguageCode) || "en",
          theme: parsed.theme || "system",
          accessibility: {
            ...prev.accessibility,
            ...parsed.accessibility
          },
          sound: parsed.sound?.enabled !== undefined ? parsed.sound.enabled : true
        }))

        if (parsed.language) {
          i18n.changeLanguage(parsed.language)
        }
      } catch (e) {
        console.error("Failed to load user preferences", e)
      }
    }
  }, [i18n])

  useEffect(() => {
    const root = window.document.documentElement

    let actualTheme = settings.theme
    if (settings.theme === "system") {
      actualTheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
    }

    root.classList.remove("light", "dark")
    root.classList.add(actualTheme)

    if (settings.accessibility.highContrast) root.classList.add("high-contrast")
    else root.classList.remove("high-contrast")

    if (settings.accessibility.largeText) root.classList.add("large-text")
    else root.classList.remove("large-text")

    if (settings.accessibility.reduceMotion) root.classList.add("reduce-motion")
    else root.classList.remove("reduce-motion")

    root.lang = settings.language
  }, [settings])

  const setLanguage = (code: LanguageCode) => {
    // 1. Update i18next
    i18n.changeLanguage(code)

    // 2. Set Google Translate cookie for the widget (enables translation of dynamic/all text)
    // The format is /pageLanguage/targetLanguage, e.g. /en/hi
    document.cookie = `googtrans=/en/${code}; path=/; expires=Fri, 31 Dec 9999 23:59:59 GMT;`
    document.cookie = `googtrans=/en/${code}; domain=.${window.location.hostname}; path=/; expires=Fri, 31 Dec 9999 23:59:59 GMT;`

    // 3. Update local state
    setSettings(prev => ({ ...prev, language: code }))
    localStorage.setItem("app-language", code)

    // 4. Force reload might be needed for the Google Widget to trigger if not already active,
    // although cookie setting usually works on next navigation.
    // To make it instant on the same page:
    const translateElement = document.querySelector('.goog-te-combo') as HTMLSelectElement
    if (translateElement) {
      translateElement.value = code
      translateElement.dispatchEvent(new Event('change'))
    }
  }

  const setTheme = (theme: "light" | "dark" | "system") => {
    setSettings(prev => ({ ...prev, theme }))
  }

  const setAccessibility = (access: Partial<AppSettings["accessibility"]>) => {
    setSettings(prev => ({
      ...prev,
      accessibility: { ...prev.accessibility, ...access }
    }))
  }

  const setSound = (enabled: boolean) => {
    setSettings(prev => ({ ...prev, sound: enabled }))
  }

  return (
    <LanguageContext.Provider value={{
      language: settings.language,
      theme: settings.theme,
      accessibility: settings.accessibility,
      sound: settings.sound,
      setLanguage,
      setTheme,
      setAccessibility,
      setSound,
      t
    }}>
      {children}
    </LanguageContext.Provider>
  )
}

export function useLanguage() {
  const context = useContext(LanguageContext)
  if (context === undefined) {
    throw new Error("useLanguage must be used within a LanguageProvider")
  }
  return context
}
