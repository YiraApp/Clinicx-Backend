"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Settings, Globe, Bell, Moon, Sun, Monitor, CheckCircle, Palette, Volume2, VolumeX } from "lucide-react"
import { useCurrentRole } from "@/hooks/use-current-role"
import { INDIAN_LANGUAGES, useLanguage, type LanguageCode } from "@/lib/i18n/language-context"

interface UserPreferences {
    language: LanguageCode
    theme: "light" | "dark" | "system"
    notifications: {
        email: boolean
        sms: boolean
        push: boolean
        appointmentReminders: boolean
        labResults: boolean
        prescriptionRefills: boolean
    }
    accessibility: {
        highContrast: boolean
        largeText: boolean
        reduceMotion: boolean
        screenReaderOptimized: boolean
    }
    sound: {
        enabled: boolean
        notificationSound: boolean
    }
}

export default function UserSettingsPage() {
    const { role } = useCurrentRole()
    const {
        language: currentLanguage,
        setLanguage: setGlobalLanguage,
        setTheme,
        setAccessibility,
        setSound: setGlobalSound,
        t
    } = useLanguage()
    const [preferences, setPreferences] = useState<UserPreferences>({
        language: "en",
        theme: "system",
        notifications: {
            email: true,
            sms: true,
            push: true,
            appointmentReminders: true,
            labResults: true,
            prescriptionRefills: true,
        },
        accessibility: {
            highContrast: false,
            largeText: false,
            reduceMotion: false,
            screenReaderOptimized: false,
        },
        sound: {
            enabled: true,
            notificationSound: true,
        },
    })

    const [saving, setSaving] = useState(false)
    const [success, setSuccess] = useState("")
    const [activeTab, setActiveTab] = useState("language")

    useEffect(() => {
        // Load saved preferences
        const savedPrefs = localStorage.getItem("yira-user-preferences")
        if (savedPrefs) {
            try {
                const parsed = JSON.parse(savedPrefs)
                setPreferences(prev => ({ ...prev, ...parsed }))
            } catch (e) {
                console.error("Failed to parse preferences:", e)
            }
        }

        // Sync with global language context
        setPreferences(prev => ({ ...prev, language: currentLanguage }))
    }, [currentLanguage])

    const handleSave = async () => {
        setSaving(true)
        try {
            // Save to localStorage
            localStorage.setItem("yira-user-preferences", JSON.stringify(preferences))

            // Update global context (applies changes to UI)
            setGlobalLanguage(preferences.language)
            setTheme(preferences.theme)
            setAccessibility(preferences.accessibility)
            setGlobalSound(preferences.sound.enabled)

            setSuccess(t("settingsSaved") || "Settings saved successfully!")
            setTimeout(() => setSuccess(""), 3000)
        } finally {
            setSaving(false)
        }
    }

    const updatePreference = <K extends keyof UserPreferences>(
        section: K,
        value: UserPreferences[K]
    ) => {
        setPreferences(prev => ({ ...prev, [section]: value }))
    }

    const updateNestedPreference = <K extends keyof UserPreferences>(
        section: K,
        field: string,
        value: boolean
    ) => {
        setPreferences(prev => ({
            ...prev,
            [section]: {
                ...(prev[section] as Record<string, boolean>),
                [field]: value,
            },
        }))
    }

    const selectedLanguage = INDIAN_LANGUAGES.find(l => l.code === preferences.language)

    return (
        <div className="p-6 max-w-5xl mx-auto animate-in fade-in slide-in-from-bottom-4 duration-500">
            {/* Header */}
            <div className="mb-6">
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-2xl font-medium text-foreground flex items-center gap-2">
                            <Settings className="h-6 w-6 text-primary" />
                            {t("userSettings")}
                        </h1>
                        <p className="text-sm text-muted-foreground mt-1">Customize your experience and preferences</p>
                    </div>
                    <Button onClick={handleSave} disabled={saving} className="bg-primary hover:opacity-90 shadow-md transition-all text-white">
                        {saving ? "Saving..." : t("saveChanges")}
                    </Button>
                </div>
            </div>

            {/* Success Alert */}
            {success && (
                <Alert variant="success" className="mb-4 animate-in zoom-in-95 duration-200 shadow-sm">
                    <CheckCircle className="h-4 w-4" />
                    <AlertDescription className="font-medium">{success}</AlertDescription>
                </Alert>
            )}

            <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
                <TabsList className="grid w-full grid-cols-4 h-auto p-1 bg-muted/50 backdrop-blur-sm border border-border">
                    <TabsTrigger value="language" className="flex items-center gap-2 py-2 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm hover:bg-accent/50 transition-colors">
                        <Globe className="h-4 w-4" />
                        <span className="hidden sm:inline">{t("language")}</span>
                    </TabsTrigger>
                    <TabsTrigger value="appearance" className="flex items-center gap-2 py-2 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm hover:bg-accent/50 transition-colors">
                        <Palette className="h-4 w-4" />
                        <span className="hidden sm:inline">{t("appearance")}</span>
                    </TabsTrigger>
                    <TabsTrigger value="notifications" className="flex items-center gap-2 py-2 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm hover:bg-accent/50 transition-colors">
                        <Bell className="h-4 w-4" />
                        <span className="hidden sm:inline">{t("notifications")}</span>
                    </TabsTrigger>
                    <TabsTrigger value="accessibility" className="flex items-center gap-2 py-2 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm hover:bg-accent/50 transition-colors">
                        <Monitor className="h-4 w-4" />
                        <span className="hidden sm:inline">{t("accessibility")}</span>
                    </TabsTrigger>
                </TabsList>

                {/* Language Settings */}
                <TabsContent value="language" className="animate-in fade-in-50 duration-300">
                    <Card className="border-border shadow-sm overflow-hidden">
                        <CardHeader className="bg-muted/30 border-b border-border">
                            <CardTitle className="flex items-center gap-2 text-foreground">
                                <Globe className="h-5 w-5 text-primary" />
                                {t("language")}
                            </CardTitle>
                            <CardDescription className="text-muted-foreground">
                                Choose your preferred language for the application
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-6 pt-6">
                            <div className="space-y-4">
                                <Label className="text-base font-medium text-foreground">{t("selectLanguage")}</Label>
                                <p className="text-sm text-muted-foreground">
                                    The application supports all major Indian languages for better accessibility
                                </p>

                                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                                    {INDIAN_LANGUAGES.map((lang) => (
                                        <div
                                            key={lang.code}
                                            onClick={() => updatePreference("language", lang.code)}
                                            className={`p-4 rounded-xl border-2 cursor-pointer transition-all duration-200 ${preferences.language === lang.code
                                                ? "border-primary bg-primary/10 shadow-sm"
                                                : "border-border hover:border-primary/50 hover:bg-accent/50"
                                                }`}
                                        >
                                            <div className="flex flex-col gap-1">
                                                <div className="flex items-center justify-between">
                                                    <p className="font-medium text-foreground">{lang.name}</p>
                                                    {preferences.language === lang.code && (
                                                        <CheckCircle className="h-5 w-5 text-primary" />
                                                    )}
                                                </div>
                                                <p className="text-xl text-muted-foreground font-serif">{lang.nativeName}</p>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {selectedLanguage && (
                                <div className="p-5 bg-primary/10 rounded-xl border border-primary/20 flex items-start gap-4">
                                    <div className="p-2 bg-primary/10 rounded-lg">
                                        <Globe className="h-5 w-5 text-primary" />
                                    </div>
                                    <div>
                                        <p className="text-sm text-foreground">
                                            <span className="font-medium underline decoration-primary/20 underline-offset-2">{t("currentSelection")}:</span>
                                            <span className="ml-2 bg-primary/10 px-2 py-0.5 rounded-full text-xs font-medium uppercase tracking-wider text-primary">{selectedLanguage.name}</span>
                                        </p>
                                        <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed font-medium">
                                            {t("interfaceDisplay")}
                                        </p>
                                    </div>
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </TabsContent>

                {/* Appearance Settings */}
                <TabsContent value="appearance" className="animate-in fade-in-50 duration-300">
                    <Card className="border-border shadow-sm">
                        <CardHeader className="bg-muted/30 border-b border-border">
                            <CardTitle className="flex items-center gap-2 text-foreground">
                                <Palette className="h-5 w-5 text-primary" />
                                {t("appearance")}
                            </CardTitle>
                            <CardDescription className="text-muted-foreground">
                                Customize how the application looks
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-8 pt-6">
                            <div className="space-y-4">
                                <Label className="text-base font-medium text-foreground">Theme Preference</Label>
                                <div className="grid grid-cols-3 gap-4">
                                    <div
                                        onClick={() => updatePreference("theme", "light")}
                                        className={`p-6 rounded-xl border-2 cursor-pointer transition-all flex flex-col items-center gap-3 ${preferences.theme === "light"
                                            ? "border-primary bg-primary/10 shadow-sm"
                                            : "border-border hover:border-primary/50 hover:bg-accent/50"
                                            }`}
                                    >
                                        <div className={`p-3 rounded-full ${preferences.theme === "light" ? "bg-amber-100" : "bg-muted"}`}>
                                            <Sun className={`h-8 w-8 ${preferences.theme === "light" ? "text-amber-600" : "text-muted-foreground"}`} />
                                        </div>
                                        <span className="text-sm font-medium text-foreground">Light Mode</span>
                                    </div>
                                    <div
                                        onClick={() => updatePreference("theme", "dark")}
                                        className={`p-6 rounded-xl border-2 cursor-pointer transition-all flex flex-col items-center gap-3 ${preferences.theme === "dark"
                                            ? "border-primary bg-primary/10 shadow-sm"
                                            : "border-border hover:border-primary/50 hover:bg-accent/50"
                                            }`}
                                    >
                                        <div className={`p-3 rounded-full ${preferences.theme === "dark" ? "bg-slate-800" : "bg-muted"}`}>
                                            <Moon className={`h-8 w-8 ${preferences.theme === "dark" ? "text-slate-100" : "text-muted-foreground"}`} />
                                        </div>
                                        <span className="text-sm font-medium text-foreground">Dark Mode</span>
                                    </div>
                                    <div
                                        onClick={() => updatePreference("theme", "system")}
                                        className={`p-6 rounded-xl border-2 cursor-pointer transition-all flex flex-col items-center gap-3 ${preferences.theme === "system"
                                            ? "border-primary bg-primary/10 shadow-sm"
                                            : "border-border hover:border-primary/50 hover:bg-accent/50"
                                            }`}
                                    >
                                        <div className={`p-3 rounded-full ${preferences.theme === "system" ? "bg-slate-200" : "bg-muted"}`}>
                                            <Monitor className={`h-8 w-8 ${preferences.theme === "system" ? "text-slate-700" : "text-muted-foreground"}`} />
                                        </div>
                                        <span className="text-sm font-medium text-foreground">System Default</span>
                                    </div>
                                </div>
                            </div>

                            <div className="flex items-center justify-between p-5 rounded-xl bg-muted/50 border border-border transition-all hover:bg-accent/50">
                                <div className="flex items-center gap-4">
                                    <div className={`p-2 rounded-lg ${preferences.sound.enabled ? "bg-emerald-100/20" : "bg-muted"}`}>
                                        {preferences.sound.enabled ? (
                                            <Volume2 className="h-5 w-5 text-emerald-500" />
                                        ) : (
                                            <VolumeX className="h-5 w-5 text-muted-foreground" />
                                        )}
                                    </div>
                                    <div>
                                        <Label className="text-base font-medium text-foreground">Sound Effects</Label>
                                        <p className="text-sm text-muted-foreground">Play subtle sounds for notifications and actions</p>
                                    </div>
                                </div>
                                <Switch
                                    checked={preferences.sound.enabled}
                                    onCheckedChange={(checked: boolean) => updateNestedPreference("sound", "enabled", checked)}
                                    className="data-[state=checked]:bg-primary"
                                />
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>

                {/* Notification Settings */}
                <TabsContent value="notifications" className="animate-in fade-in-50 duration-300">
                    <Card className="border-border shadow-sm">
                        <CardHeader className="bg-muted/30 border-b border-border">
                            <CardTitle className="flex items-center gap-2 text-foreground">
                                <Bell className="h-5 w-5 text-primary" />
                                {t("notifications")}
                            </CardTitle>
                            <CardDescription className="text-muted-foreground">
                                Choose how and when you want to be notified
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-8 pt-6">
                            <div className="space-y-4">
                                <Label className="text-sm font-medium uppercase tracking-wider text-primary/80">Notification Channels</Label>

                                <div className="grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-2">
                                    {[
                                        { id: "email", label: "Email", desc: "For detailed reports" },
                                        { id: "sms", label: "SMS", desc: "For urgent alerts" },
                                        { id: "push", label: "Push", desc: "For quick updates" }
                                    ].map((channel) => (
                                        <div key={channel.id} className="flex items-center justify-between p-4 rounded-xl border border-border bg-muted/30">
                                            <div>
                                                <p className="font-medium text-foreground">{channel.label}</p>
                                                <p className="text-xs text-muted-foreground">{channel.desc}</p>
                                            </div>
                                            <Switch
                                                checked={preferences.notifications[channel.id as keyof typeof preferences.notifications]}
                                                onCheckedChange={(checked: boolean) => updateNestedPreference("notifications", channel.id, checked)}
                                                className="data-[state=checked]:bg-primary"
                                            />
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div className="space-y-4 pt-6 border-t border-border">
                                <Label className="text-sm font-medium uppercase tracking-wider text-primary/80">Alert Types</Label>

                                <div className="space-y-3">
                                    {[
                                        { id: "appointmentReminders", label: "Appointment Reminders", desc: "Get reminded about your upcoming consultations" },
                                        { id: "labResults", label: "Lab Results", desc: "Immediate alert when your lab reports are published" },
                                        { id: "prescriptionRefills", label: "Prescription Refills", desc: "Reminders for timely medication renewals" }
                                    ].map((type) => (
                                        <div key={type.id} className="flex items-center justify-between p-5 rounded-xl hover:bg-accent/50 transition-colors border border-transparent hover:border-border">
                                            <div className="flex items-start gap-4">
                                                <div className="mt-1 p-2 bg-primary/10 rounded-full">
                                                    <CheckCircle className="h-3 w-3 text-primary" />
                                                </div>
                                                <div>
                                                    <p className="font-medium text-foreground">{type.label}</p>
                                                    <p className="text-sm text-muted-foreground">{type.desc}</p>
                                                </div>
                                            </div>
                                            <Switch
                                                checked={preferences.notifications[type.id as keyof typeof preferences.notifications]}
                                                onCheckedChange={(checked: boolean) => updateNestedPreference("notifications", type.id, checked)}
                                                className="data-[state=checked]:bg-primary"
                                            />
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>

                {/* Accessibility Settings */}
                <TabsContent value="accessibility" className="animate-in fade-in-50 duration-300">
                    <Card className="border-border shadow-sm">
                        <CardHeader className="bg-muted/30 border-b border-border">
                            <CardTitle className="flex items-center gap-2 text-foreground">
                                <Monitor className="h-5 w-5 text-primary" />
                                {t("accessibility")}
                            </CardTitle>
                            <CardDescription className="text-muted-foreground">
                                Make the application work better for your needs
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="pt-6">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {[
                                    { id: "highContrast", label: "High Contrast", desc: "Increase color contrast for text" },
                                    { id: "largeText", label: "Large Text", desc: "Scales font size for better legibility" },
                                    { id: "reduceMotion", label: "Reduce Motion", desc: "Minimize screen animations" },
                                    { id: "screenReaderOptimized", label: "Screen Reader", desc: "Enhance compatibility for accessibility tools" }
                                ].map((feature) => (
                                    <div key={feature.id} className="flex items-center justify-between p-5 rounded-xl bg-muted/50 border border-border hover:border-primary/50 hover:bg-accent/50 hover:shadow-md transition-all duration-300">
                                        <div>
                                            <p className="font-medium text-foreground">{feature.label}</p>
                                            <p className="text-xs text-muted-foreground mt-0.5">{feature.desc}</p>
                                        </div>
                                        <Switch
                                            checked={preferences.accessibility[feature.id as keyof typeof preferences.accessibility]}
                                            onCheckedChange={(checked: boolean) => updateNestedPreference("accessibility", feature.id, checked)}
                                            className="data-[state=checked]:bg-primary"
                                        />
                                    </div>
                                ))}
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>
            </Tabs>
        </div>
    )
}
