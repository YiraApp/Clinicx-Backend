import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { Search, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { useLanguage } from "@/lib/i18n/language-context"

interface GlobalPatientSearchProps {
  variant?: "compact" | "full"
}

export function GlobalPatientSearch({ variant = "compact" }: GlobalPatientSearchProps) {
  const { t } = useLanguage()
  const [query, setQuery] = useState("")
  const navigate = useNavigate()

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    if (query.trim()) {
      navigate(`/patients?search=${encodeURIComponent(query.trim())}`)
      setQuery("")
    }
  }

  return (
    <form onSubmit={handleSearch} className="relative group">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground group-focus-within:text-primary transition-colors" />
      <input
        type="text"
        placeholder={t("Search patients...")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="w-full bg-muted/50 border border-border rounded-xl py-2 pl-10 pr-12 text-sm outline-none focus:bg-background focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all font-medium placeholder:text-muted-foreground shadow-sm"
      />
      {query ? (
        <button
          type="button"
          onClick={() => setQuery("")}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-slate-200 transition-colors"
        >
          <X className="h-3.5 w-3.5 text-slate-400" />
        </button>
      ) : (
        <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5 px-1.5 py-1 bg-background border border-border rounded-md text-[10px] font-bold text-muted-foreground shadow-sm pointer-events-none tracking-tighter">
          <span>⌘</span>
          <span className="ml-0.5">K</span>
        </div>
      )}
    </form>
  )
}
