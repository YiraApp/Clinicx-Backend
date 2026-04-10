"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Building2, Globe, Palette, Shield, CheckCircle, Save, Info, AppWindow } from "lucide-react"
import { INDIAN_LANGUAGES, useLanguage, type LanguageCode } from "@/lib/i18n/language-context"
import { DashboardHeader } from "@/components/DashboardHeader"

interface OrgPreferences {
    defaultLanguage: LanguageCode
    brandColor: string
    allowUserThemeOverrides: boolean
    requireMultiFactorAuth: boolean
    publicProfileVisible: boolean
    enableAIAssistance: boolean
    retentionPeriod: number
}

export default function OrganizationSettingsPage() {
    const { language: currentLanguage, setLanguage: setGlobalLanguage, t } = useLanguage()
    const [preferences, setPreferences] = useState<OrgPreferences>({
        defaultLanguage: "en",
        brandColor: "#4f46e5",
        allowUserThemeOverrides: true,
        requireMultiFactorAuth: false,
        publicProfileVisible: true,
        enableAIAssistance: true,
        retentionPeriod: 365,
    })

    const [saving, setSaving] = useState(false)
    const [success, setSuccess] = useState("")
    const [activeTab, setActiveTab] = useState("general")

    useEffect(() => {
        const savedOrgPrefs = localStorage.getItem("yira-org-preferences")
        if (savedOrgPrefs) {
            try {
                const parsed = JSON.parse(savedOrgPrefs)
                setPreferences(prev => ({ ...prev, ...parsed }))
            } catch (e) {
                console.error("Failed to parse org preferences:", e)
            }
        }
    }, [])

    const handleSave = async () => {
        setSaving(true)
        try {
            localStorage.setItem("yira-org-preferences", JSON.stringify(preferences))

            // If the org-wide language was changed, optionally update the current session's language
            setGlobalLanguage(preferences.defaultLanguage)

            setSuccess("Settings saved successfully!")
            setTimeout(() => setSuccess(""), 3000)
        } finally {
            setSaving(false)
        }
    }

    const updatePreference = <K extends keyof OrgPreferences>(
        field: K,
        value: OrgPreferences[K]
    ) => {
        setPreferences(prev => ({ ...prev, [field]: value }))
    }

    const selectedLanguage = INDIAN_LANGUAGES.find(l => l.code === preferences.defaultLanguage)

    return (
        <div className="p-6 max-w-5xl mx-auto animate-in fade-in slide-in-from-bottom-4 duration-500">
            {/* Header */}
            <DashboardHeader
                title={t("orgSettings")}
                subtitle="Configure global policies and branding for your organization"
            >
                <Button
                    onClick={handleSave}
                    disabled={saving}
                    className="bg-primary hover:opacity-90 h-11 px-6 shadow-md transition-all text-white"
                >
                    {saving ? "Saving..." : (
                        <>
                            <Save className="mr-2 h-4 w-4" />
                            {t("saveChanges")}
                        </>
                    )}
                </Button>
            </DashboardHeader>

            {/* Success Alert */}
            {success && (
                <Alert variant="success" className="mb-6 animate-in fade-in slide-in-from-top-2 shadow-sm">
                    <CheckCircle className="h-4 w-4" />
                    <AlertDescription className="font-medium">{success}</AlertDescription>
                </Alert>
            )}

            <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
                <TabsList className="bg-muted/50 border border-border p-1 rounded-xl h-14">
                    <TabsTrigger value="general" className="flex items-center gap-2 px-6 h-full data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm hover:bg-accent/50 transition-colors rounded-lg font-medium">
                        <AppWindow className="h-4 w-4 text-muted-foreground" />
                        General
                    </TabsTrigger>
                    <TabsTrigger value="language" className="flex items-center gap-2 px-6 h-full data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm hover:bg-accent/50 transition-colors rounded-lg font-medium">
                        <Globe className="h-4 w-4 text-muted-foreground" />
                        Language & Region
                    </TabsTrigger>
                    <TabsTrigger value="branding" className="flex items-center gap-2 px-6 h-full data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm hover:bg-accent/50 transition-colors rounded-lg font-medium">
                        <Palette className="h-4 w-4 text-muted-foreground" />
                        Branding
                    </TabsTrigger>
                    <TabsTrigger value="security" className="flex items-center gap-2 px-6 h-full data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm hover:bg-accent/50 transition-colors rounded-lg font-medium">
                        <Shield className="h-4 w-4 text-muted-foreground" />
                        Security
                    </TabsTrigger>
                </TabsList>

                {/* General Settings */}
                <TabsContent value="general" className="animate-in fade-in-50 duration-300">
                    <Card className="border-border shadow-sm">
                        <CardHeader className="bg-muted/30 border-b border-border px-8 py-6">
                            <CardTitle className="text-xl font-medium flex items-center gap-2 text-foreground">
                                Base Configuration
                                <Info className="h-4 w-4 text-muted-foreground" />
                            </CardTitle>
                            <CardDescription className="text-muted-foreground">Adjust organizational behavior and AI features</CardDescription>
                        </CardHeader>
                        <CardContent className="p-8 space-y-6">
                            <div className="flex items-center justify-between p-6 bg-muted/30 rounded-2xl border border-border">
                                <div className="space-y-1">
                                    <p className="font-medium text-foreground">Enable AI Medical Insights</p>
                                    <p className="text-sm text-muted-foreground">Allow the system to generate AI-powered medical summaries and insights</p>
                                </div>
                                <Switch
                                    checked={preferences.enableAIAssistance}
                                    onCheckedChange={(checked: boolean) => updatePreference("enableAIAssistance", checked)}
                                    className="data-[state=checked]:bg-primary h-7 w-12"
                                />
                            </div>

                            <div className="flex items-center justify-between p-6 bg-muted/30 rounded-2xl border border-border">
                                <div className="space-y-1">
                                    <p className="font-medium text-foreground">Public Profile Visibility</p>
                                    <p className="text-sm text-muted-foreground">Make organization contact info visible to patients on the public portal</p>
                                </div>
                                <Switch
                                    checked={preferences.publicProfileVisible}
                                    onCheckedChange={(checked: boolean) => updatePreference("publicProfileVisible", checked)}
                                    className="data-[state=checked]:bg-primary h-7 w-12"
                                />
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>

                {/* Language Settings */}
                <TabsContent value="language" className="animate-in fade-in-50 duration-300">
                    <Card className="border-border shadow-sm">
                        <CardHeader className="bg-muted/30 border-b border-border px-8 py-6">
                            <CardTitle className="text-xl font-medium text-foreground">Default Language Settings</CardTitle>
                            <CardDescription className="text-muted-foreground">Defines the system language for all members unless overridden</CardDescription>
                        </CardHeader>
                        <CardContent className="p-8 space-y-8">
                            <div className="space-y-4">
                                <Label className="text-sm font-medium uppercase text-primary tracking-widest">{t("selectLanguage")}</Label>
                                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
                                    {INDIAN_LANGUAGES.map((lang) => (
                                        <div
                                            key={lang.code}
                                            onClick={() => updatePreference("defaultLanguage", lang.code)}
                                            className={`p-5 rounded-2xl border-2 cursor-pointer transition-all duration-300 group flex flex-col items-center text-center gap-2 ${preferences.defaultLanguage === lang.code
                                                ? "border-primary bg-primary/10 shadow-md"
                                                : "border-border hover:border-primary/50 hover:bg-accent/50"
                                                }`}
                                        >
                                            <div className={`h-10 w-10 rounded-full flex items-center justify-center transition-colors ${preferences.defaultLanguage === lang.code ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground group-hover:bg-primary/20 group-hover:text-primary"
                                                }`}>
                                                <Globe className="h-5 w-5" />
                                            </div>
                                            <div>
                                                <p className="font-medium text-foreground group-hover:text-primary">{lang.name}</p>
                                                <p className="text-lg text-muted-foreground font-serif leading-tight">{lang.nativeName}</p>
                                            </div>
                                            {preferences.defaultLanguage === lang.code && (
                                                <div className="mt-1">
                                                    <CheckCircle className="h-4 w-4 text-primary" />
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {selectedLanguage && (
                                <div className="mt-8 p-6 bg-primary/10 rounded-3xl border border-primary/20 relative overflow-hidden group shadow-sm">
                                    <div className="absolute top-0 right-0 p-8 opacity-5 transform group-hover:scale-110 transition-transform">
                                        <Globe className="h-32 w-32" />
                                    </div>
                                    <div className="relative z-10">
                                        <p className="text-primary font-medium text-sm uppercase tracking-tighter mb-1">Global Language Override</p>
                                        <h3 className="text-2xl font-medium text-foreground flex items-center gap-3">
                                            {selectedLanguage.name}
                                            <span className="text-muted-foreground font-serif text-xl">({selectedLanguage.nativeName})</span>
                                        </h3>
                                        <p className="text-primary/80 mt-2 max-w-lg text-sm font-medium leading-relaxed">
                                            All new users will be onboarded with this language. Current users who haven't set a preference will see the platform in <span className="font-medium underline">{selectedLanguage.name}</span>.
                                        </p>
                                    </div>
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </TabsContent>

                {/* Branding & Style */}
                <TabsContent value="branding" className="animate-in fade-in-50 duration-300">
                    <Card className="border-border shadow-sm">
                        <CardHeader className="bg-muted/30 border-b border-border px-8 py-6">
                            <CardTitle className="text-xl font-medium text-foreground">Brand Design</CardTitle>
                            <CardDescription className="text-muted-foreground">Customize the visual identity of your portal</CardDescription>
                        </CardHeader>
                        <CardContent className="p-8 space-y-8">
                            <div className="flex items-center justify-between p-6 bg-muted/30 rounded-2xl border border-border">
                                <div className="space-y-1">
                                    <p className="font-medium text-foreground">Allow Theme Overrides</p>
                                    <p className="text-sm text-muted-foreground">Allow individual users to switch between Light, Dark, and System themes</p>
                                </div>
                                <Switch
                                    checked={preferences.allowUserThemeOverrides}
                                    onCheckedChange={(checked: boolean) => updatePreference("allowUserThemeOverrides", checked)}
                                    className="data-[state=checked]:bg-primary h-7 w-12"
                                />
                            </div>

                            <div className="space-y-4">
                                <Label className="text-sm font-medium uppercase text-primary tracking-widest">Brand Accent Color</Label>
                                <div className="flex gap-4">
                                    {["#4f46e5", "#ef4444", "#10b981", "#8b5cf6", "#f59e0b"].map(color => (
                                        <div
                                            key={color}
                                            onClick={() => updatePreference("brandColor", color)}
                                            className={`h-12 w-12 rounded-full cursor-pointer border-4 transition-all hover:scale-110 flex items-center justify-center ${preferences.brandColor === color ? "border-foreground shadow-lg scale-110" : "border-border shadow-sm"
                                                }`}
                                            style={{ backgroundColor: color }}
                                        >
                                            {preferences.brandColor === color && <CheckCircle className="h-5 w-5 text-white" />}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>
            </Tabs>
        </div>
    )
}
