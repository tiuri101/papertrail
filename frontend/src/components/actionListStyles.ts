import { cn } from '../lib/cn'

const base =
  'flex !h-auto w-full items-center justify-start gap-2 rounded-sm !border-0 !bg-transparent !bg-none text-left font-medium leading-normal whitespace-normal text-text no-underline !shadow-none !transform-none hover:!bg-surface-hover hover:text-text hover:underline disabled:opacity-[.48] [&_svg]:shrink-0 [&_svg]:fill-current'

const sizes = {
  sm: '!min-h-[34px] px-2 !py-0 text-[0.86rem] [&_svg]:size-4',
  md: '!min-h-[38px] !p-2 text-[0.9rem] [&_svg]:size-[18px]',
} as const

export function actionListItemClass({ size = 'sm', danger = false }: {
  size?: keyof typeof sizes
  danger?: boolean
} = {}) {
  return cn(base, sizes[size], danger && '!text-danger hover:!text-danger')
}
