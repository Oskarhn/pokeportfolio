import { Link } from '@tanstack/react-router'
import { SEALED_PRODUCT_TYPE_LABEL, type SealedProductSummary } from '../../data/sealedProducts'
import { SealedProductImage } from './SealedProductImage'
import { AddSealedQuickButton } from './AddSealedQuickButton'

/** CardResultCard's sealed counterpart (M11 prompt §50-52). Square-ish image area rather than
 *  CardResultCard's 5:7 card aspect — boxes, tins and ETBs read better close to square than
 *  stretched into a card's portrait shape. */
export function SealedResultCard({ product }: { product: SealedProductSummary }) {
  return (
    <div className="group relative rounded-xl p-1.5 hover:bg-slate-800/60">
      <Link
        to="/catalog/sealed/$sealedProductId"
        params={{ sealedProductId: product.id }}
        className="flex flex-col gap-1.5 focus-visible:outline-none"
      >
        <SealedProductImage
          imageUrl={product.imageUrl}
          productType={product.productType}
          alt={product.name}
          className="aspect-square w-full"
        />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-slate-100">
            {product.name}
            {product.isCustom ? (
              <span className="ml-1 rounded bg-slate-800 px-1 py-0.5 text-[9px] font-medium text-slate-400">
                Custom
              </span>
            ) : null}
          </p>
          <p className="truncate text-xs text-slate-400">
            {SEALED_PRODUCT_TYPE_LABEL[product.productType]}
            {product.setName ? ` · ${product.setName}` : ''}
          </p>
          <p className="truncate text-xs text-slate-500">
            {product.language === 'ja' ? 'Japanese' : 'English'}
          </p>
        </div>
      </Link>
      <div className="mt-1.5 flex items-center justify-end">
        <AddSealedQuickButton sealedProductId={product.id} />
      </div>
    </div>
  )
}
