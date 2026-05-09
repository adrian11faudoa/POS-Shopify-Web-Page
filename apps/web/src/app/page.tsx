// apps/web/src/app/page.tsx
// Customer-facing storefront homepage

import { Suspense } from 'react';
import { ProductCatalog } from '@/components/ProductCatalog';
import { HeroBanner } from '@/components/HeroBanner';
import { CategoryNav } from '@/components/CategoryNav';
import { FeaturedProducts } from '@/components/FeaturedProducts';
import { CartButton } from '@/components/cart/CartButton';
import { OrderTracker } from '@/components/OrderTracker';

export const metadata = {
  title: 'SnackStore — Fresh Snacks Delivered',
  description: 'Order your favorite snacks online or pick up in store.',
};

export default function HomePage() {
  return (
    <main className="storefront">
      <header className="storefront-header">
        <div className="header-inner">
          <a href="/" className="store-logo">🍿 SnackStore</a>
          <nav className="header-nav">
            <a href="/track">Track Order</a>
            <a href="/menu">Full Menu</a>
          </nav>
          <CartButton />
        </div>
      </header>

      <HeroBanner />

      <section className="storefront-body">
        <Suspense fallback={<div className="loading-bar" />}>
          <CategoryNav />
        </Suspense>

        <Suspense fallback={<div className="skeleton-grid" />}>
          <FeaturedProducts />
        </Suspense>

        <Suspense fallback={<div className="skeleton-grid" />}>
          <ProductCatalog />
        </Suspense>
      </section>
    </main>
  );
}
