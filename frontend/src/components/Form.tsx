import type { FormHTMLAttributes } from 'react'

import { cn } from '../lib/cn'

export const formStyles = [
  'grid grid-cols-2 gap-5',
  '[&>:not(button)]:col-span-full',
  '[&>button:only-of-type]:col-span-full [&>button:only-of-type]:justify-self-start',
  'max-[480px]:grid-cols-1 max-[480px]:[&>button]:col-span-1 max-[480px]:[&>button]:w-full',
].join(' ')

/** Standard Papertrail form layout. Use a native classed <form> for non-standard layouts. */
export function Form({ className, ...props }: FormHTMLAttributes<HTMLFormElement>) {
  return <form className={cn(formStyles, className)} {...props} />
}
