# DOM Sanitization & Regex Safety Rules Reference

## 1. The Core Regex Safety Mandate
When writing regex to strip framework attributes (Alpine, Livewire, Vue, Angular):
* **NEVER use optional leading whitespace `\s*`**:
  `\s*` matches 0 characters (empty string). Inside CSS class strings like `class="w-100 flex-center-between"`, an unanchored pattern `x-[a-z-]+` matches the substring `x-center-between` between the `e` and `x`, truncating `flex-center-between` to `fle`!
* **MUST mandate leading whitespace `\s+`**:
  Ensures that only standalone attributes preceded by whitespace are matched.
* **MUST use explicit directive whitelists**:
  Do not use wildcard `x-[a-zA-Z0-9_\\-\\.:]+`. Restrict to standard Alpine directives:
  `x-(?:data|bind|on|show|model|transition|ref|init|cloak|html|text|teleport|for|if|effect|ignore|intersect)`

---

## 2. Canonical Sanitization Regex Suite (`sanitizeSectionMarkup`)

### A. Media Embed Preservation
Do NOT strip video URLs to empty strings. If an iframe carries dynamic `:src` or `:data-src` containing YouTube or Vimeo URLs, extract the clean URL and store it into static `data-src`, with `src="about:blank"`:
```typescript
.replace(/(?::|x-bind:|v-bind:)?(?:src|data-src)\s*=\s*(?:"[^"]*(?:https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)[^"']*)["']|'[^']*(?:https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)[^"']*)['"])/gi, (match) => {
  const urlMatch = match.match(/(https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\/[^"'\s)]+)/i);
  const cleanUrl = urlMatch ? urlMatch[1] : 'https://www.youtube.com/embed/Nt2J6ZXPuw0';
  return `data-src="${cleanUrl}" src=""`;
})
```

### B. Dynamic Bindings Clean-Up
```typescript
.replace(/(?::|x-bind:|v-bind:)(src|data-src)\s*=\s*(?:"[^"]*(?:https?:)?\/\/[^"]*"|'[^']*(?:https?:)?\/\/[^']*')/gi, '')
.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
.replace(/<!--\[if (?:END)?BLOCK\]>[\s\S]*?<!\[endif\]-->/gi, '')
```

### C. Livewire Directives
```typescript
.replace(/\s+wire:[a-zA-Z0-9_\-\.]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '')
```

### D. Alpine Directives & Class Safety
```typescript
.replace(/\s+(?:x-(?:data|bind|on|show|model|transition|ref|init|cloak|html|text|teleport|for|if|effect|ignore|intersect)(?::[a-zA-Z0-9_\-\.]+)?|@[a-zA-Z0-9_\-\.:]+)(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '')
.replace(/\s+:class=(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
```

### E. Trackers, SPA Flags & Chat Widgets
```typescript
.replace(/\s+data-(?:update-uri|navigate-once)(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '')
.replace(/<script\b[^>]*src="[^"]*(?:livewire|googletagmanager|google-analytics|analytics\.js|gtag|clarity|tawk\.to|connect\.facebook\.net)[^"]*"[^>]*>[\s\S]*?<\/script>/gi, '')
.replace(/<script\b[^>]*>(?:[\s\S]*?(?:gtag\(|dataLayer\.push|fbq\(|clarity\(|Tawk_API)[\s\S]*?)<\/script>/gi, '')
.replace(/<iframe\b[^>]*(?:googletagmanager|facebook\.com\/plugins|tawk\.to)[^>]*>[\s\S]*?<\/iframe>/gi, '')
```

### F. Lazy Image Promotion
Convert `img[loading="lazy"]` and `data-src` to eager `src` so offline viewers and screenshot capture do not stall on unmounted IntersectionObservers:
```typescript
.replace(/<img\b[^>]*>/gi, (tag) => promoteLazyLoadTarget(tag));
```

---

## 3. TreeWalker Memory Sanitizer Contract (`tree-walker-sanitizer.ts`)
1. **Never inject inline `style="display: none !important;"` on modals that need JS toggles** (`#popup-video`, `#popup-login`). Use declarative CSS `:not(.active) { display: none !important; }` instead.
2. **Auto-ensure container class parity**: If an element has `id="category-navigation__sub"`, ensure `el.classList.add('category-navigation__sub')`.
3. **Lazy Image Promotion**: Convert `img[loading="lazy"]` to `img[loading="eager"]`.
