import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

// Design system (decision 2026-11-06): 44px touch targets by default, rounded, one filled
// brand button per screen; secondary is a soft tint, ghost is text, destructive is red.
const buttonVariants = cva(
  "btn inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap font-semibold outline-none select-none transition-[background-color,color,transform,opacity] duration-150 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-45 active:scale-[.98] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[18px]",
  {
    variants: {
      variant: {
        default: "btn-primary",
        secondary: "btn-secondary",
        outline: "btn-outline",
        ghost: "btn-ghost",
        destructive: "btn-danger",
        link: "btn-link",
      },
      size: {
        default: "h-11 rounded-[12px] px-4 text-[15px]",
        sm: "h-9 rounded-[10px] px-3 text-[13px] [&_svg:not([class*='size-'])]:size-4",
        lg: "h-12 rounded-[14px] px-5 text-[16px]",
        xs: "h-7 rounded-[8px] px-2 text-[12px] [&_svg:not([class*='size-'])]:size-3.5",
        icon: "size-11 rounded-full",
        "icon-sm": "size-9 rounded-full [&_svg:not([class*='size-'])]:size-4",
        "icon-xs": "size-7 rounded-full [&_svg:not([class*='size-'])]:size-3.5",
        "icon-lg": "size-12 rounded-full",
        pill: "h-9 rounded-full px-4 text-[13px] [&_svg:not([class*='size-'])]:size-4",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
