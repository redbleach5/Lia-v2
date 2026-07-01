"use client"

import { Toaster as Sonner, ToasterProps } from "sonner"

/**
 * Sonner Toaster.
 *
 * Тема зафиксирована как "light" — приложение "Лия v2" использует единую
 * светлую палитру «Тёплый лён» (см. globals.css). Если понадобится тёмная
 * тема, нужно:
 *   1. Вернуть `next-themes` в deps и обернуть layout в <ThemeProvider>
 *   2. Определить `.dark` селектор в globals.css с тёмной палитрой
 *   3. Убрать `theme="light"` здесь, использовать `useTheme()` из next-themes
 *
 * До тех пор `next-themes` не нужен — это мёртвая зависимость.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="light"
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
