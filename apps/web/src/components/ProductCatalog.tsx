// apps/web/src/components/ProductCatalog.tsx
// Server + client hybrid: SSR initial data, optimistic cart updates

'use client';

import { useState, useCallback, useTransition } from 'react';
import { useCartStore } from '@/stores/cart.store';
import { ProductCustomizationModal } from './ProductCustomizationModal';
import type { Product, ProductVariant } from '@snackpos/types';

interface ProductCatalogProps {
  initialProducts?: Product[];
  categoryId?: string;
  storeId?: string;
}

export function ProductCatalog({
  initialProducts = [],
  categoryId,
  storeId = process.env.NEXT_PUBLIC_STORE_ID!,
}: ProductCatalogProps) {
  const [products, setProducts] = useState<Product[]>(initialProducts);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [isPending, startTransition] = useTransition();

  const { addItem, items } = useCartStore();

  const cartQty = useCallback((productId: string, variantId?: string) => {
    return items
      .filter(i => i.productId === productId && (variantId ? i.variantId === variantId : true))
      .reduce((sum, i) => sum + i.quantity, 0);
  }, [items]);

  const fetchProducts = useCallback(async (searchTerm: string, catId?: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        storeId,
        isActive: 'true',
        perPage: '60',
        ...(searchTerm ? { search: searchTerm } : {}),
        ...(catId ? { categoryId: catId } : {}),
      });
      const res = await fetch(`/api/products?${params}`);
      const { data } = await res.json();
      setProducts(data ?? []);
    } finally {
      setLoading(false);
    }
  }, [storeId]);

  const handleSearch = useCallback((value: string) => {
    setSearch(value);
    startTransition(() => {
      if (value.length === 0 || value.length >= 2) {
        fetchProducts(value, categoryId);
      }
    });
  }, [fetchProducts, categoryId]);

  const handleAddSimple = useCallback((product: Product, variant: ProductVariant) => {
    addItem({
      productId: product.id,
      variantId: variant.id,
      name: product.name,
      variantName: variant.name !== 'Default' ? variant.name : null,
      price: variant.price,
      imageUrl: product.imageUrls[0] ?? null,
      modifiers: [],
      notes: '',
    });
  }, [addItem]);

  const handleProductClick = useCallback((product: Product) => {
    // If has variants/modifiers → open customization modal
    const hasOptions = product.variants.length > 1 || product.modifierGroups.length > 0;
    if (hasOptions) {
      setSelectedProduct(product);
    } else {
      handleAddSimple(product, product.variants[0]);
      showAddedFeedback(product.id);
    }
  }, [handleAddSimple]);

  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());
  const showAddedFeedback = (id: string) => {
    setAddedIds(prev => new Set([...prev, id]));
    setTimeout(() => setAddedIds(prev => { const s = new Set(prev); s.delete(id); return s; }), 1500);
  };

  return (
    <div className="product-catalog">
      {/* Search */}
      <div className="catalog-search-bar">
        <div className="search-wrapper">
          <span className="search-icon">🔍</span>
          <input
            type="search"
            placeholder="Search snacks..."
            value={search}
            onChange={e => handleSearch(e.target.value)}
            className="search-input"
            aria-label="Search products"
          />
          {isPending && <span className="search-spinner" />}
        </div>
      </div>

      {/* Grid */}
      {loading ? (
        <ProductGridSkeleton />
      ) : products.length === 0 ? (
        <div className="empty-catalog">
          <span className="empty-icon">🔍</span>
          <p>No products found{search ? ` for "${search}"` : ''}.</p>
          {search && <button className="btn-link" onClick={() => handleSearch('')}>Clear search</button>}
        </div>
      ) : (
        <div className="product-grid" role="list">
          {products.map(product => {
            const lowestPrice = Math.min(...product.variants.map(v => v.price));
            const inCart = cartQty(product.id);
            const justAdded = addedIds.has(product.id);

            return (
              <article key={product.id} className="product-card" role="listitem">
                {/* Image */}
                <div className="product-card-image">
                  {product.imageUrls[0] ? (
                    <img
                      src={product.imageUrls[0]}
                      alt={product.name}
                      loading="lazy"
                      className="product-img"
                    />
                  ) : (
                    <div className="product-img-placeholder">🍿</div>
                  )}
                  {product.isFeatured && (
                    <span className="featured-badge">⭐ Featured</span>
                  )}
                  {inCart > 0 && (
                    <span className="cart-qty-badge">{inCart} in cart</span>
                  )}
                </div>

                {/* Content */}
                <div className="product-card-body">
                  <h3 className="product-name">{product.name}</h3>
                  {product.description && (
                    <p className="product-desc">{product.description.slice(0, 80)}{product.description.length > 80 ? '...' : ''}</p>
                  )}
                  {product.tags.length > 0 && (
                    <div className="product-tags">
                      {product.tags.slice(0, 3).map(tag => (
                        <span key={tag} className="tag">{tag}</span>
                      ))}
                    </div>
                  )}
                </div>

                {/* Footer */}
                <div className="product-card-footer">
                  <div className="product-price">
                    <span className="price-current">
                      ${lowestPrice.toFixed(2)}
                    </span>
                    {product.variants.length > 1 && (
                      <span className="price-note"> from</span>
                    )}
                    {product.compareAtPrice && product.compareAtPrice > lowestPrice && (
                      <span className="price-compare">${product.compareAtPrice.toFixed(2)}</span>
                    )}
                  </div>

                  <button
                    className={`btn-add-to-cart ${justAdded ? 'btn-added' : ''}`}
                    onClick={() => handleProductClick(product)}
                    aria-label={`Add ${product.name} to cart`}
                  >
                    {justAdded ? '✓ Added!' : product.variants.length > 1 || product.modifierGroups.length > 0 ? 'Customize' : '+ Add'}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Customization Modal */}
      {selectedProduct && (
        <ProductCustomizationModal
          product={selectedProduct}
          onAdd={(item) => {
            addItem(item);
            showAddedFeedback(selectedProduct.id);
            setSelectedProduct(null);
          }}
          onClose={() => setSelectedProduct(null)}
        />
      )}
    </div>
  );
}

function ProductGridSkeleton() {
  return (
    <div className="product-grid" aria-busy="true" aria-label="Loading products">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="product-card product-card--skeleton">
          <div className="skeleton-img" />
          <div className="skeleton-line skeleton-line--title" />
          <div className="skeleton-line skeleton-line--desc" />
          <div className="skeleton-line skeleton-line--price" />
        </div>
      ))}
    </div>
  );
}
