import { Link, useParams } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  getOwnedSealedSummary,
  getSealedProduct,
  SEALED_PRODUCT_TYPE_LABEL,
} from '../../data/sealedProducts'
import { SealedProductImage } from './SealedProductImage'
import { MoneyDisplay } from '../../ui/MoneyDisplay'

/**
 * The sealed catalog's detail page (M11 prompt §53), Card Detail's counterpart for a sealed
 * product. Deliberately thin compared to Card Detail: no price chart, no market movers, no
 * variant list — there is no automatic sealed pricing at all (FINANCIAL_MODEL.md §6.3, permanent
 * project policy, not a gap to fill later). "Owned quantity" and "current value" only render when
 * the caller actually owns the product (getOwnedSealedSummary returns null otherwise) — never a
 * fabricated ×0 row.
 */
export function SealedProductDetailPage() {
  const { sealedProductId } = useParams({ from: '/catalog/sealed/$sealedProductId' })

  const product = useQuery({
    queryKey: ['sealed-product', sealedProductId],
    queryFn: () => getSealedProduct(sealedProductId),
  })
  const owned = useQuery({
    queryKey: ['owned-sealed-summary', sealedProductId],
    queryFn: () => getOwnedSealedSummary(sealedProductId),
  })

  if (product.isPending) {
    return (
      <div className="mx-auto h-64 w-full max-w-2xl animate-pulse rounded-lg bg-slate-800/60" />
    )
  }
  if (product.isError || !product.data) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-4 py-2">
        <p
          role="alert"
          className="rounded-lg border border-rose-900/60 bg-rose-950/40 p-3 text-sm text-rose-200"
        >
          That sealed product could not be found.
        </p>
        <Link to="/catalog" className="text-sm text-sky-400 underline-offset-4 hover:underline">
          ← Back to Search
        </Link>
      </div>
    )
  }

  const p = product.data

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 py-2">
      <Link to="/catalog" className="text-sm text-sky-400 underline-offset-4 hover:underline">
        ← Back to Search
      </Link>

      <div className="flex flex-col gap-4 sm:flex-row">
        <SealedProductImage
          imageUrl={p.imageUrl}
          productType={p.productType}
          alt={p.name}
          className="h-56 w-56 self-center sm:self-start"
        />
        <div className="min-w-0 flex-1 space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100">{p.name}</h1>
          <p className="text-sm text-slate-300">
            {[
              SEALED_PRODUCT_TYPE_LABEL[p.productType],
              p.setName,
              p.language === 'ja' ? 'Japanese' : 'English',
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {p.packCount ? <p className="text-sm text-slate-400">{p.packCount} packs</p> : null}
          {p.isCustom ? (
            <p className="text-xs text-slate-500">Custom product — private to your account</p>
          ) : null}

          {owned.data ? (
            <div className="space-y-0.5 pt-2">
              <p className="text-xs text-slate-500">You own ×{owned.data.quantity}</p>
              <MoneyDisplay
                state={owned.data.unitValueMinor !== null ? 'known' : 'missing'}
                minorUnits={owned.data.unitValueMinor ?? undefined}
                size="md"
              />
              {owned.data.unitValueMinor === null ? (
                <p className="text-xs text-slate-500">
                  No manual value set yet — there is no automatic sealed pricing.
                </p>
              ) : null}
            </div>
          ) : null}

          <Link
            to="/portfolio/sealed/new"
            search={{ sealedProductId: p.id }}
            className="mt-2 flex min-h-11 w-fit items-center rounded-lg bg-sky-600 px-4 text-sm font-semibold text-white hover:bg-sky-500"
          >
            Add to Portfolio
          </Link>
        </div>
      </div>
    </div>
  )
}
