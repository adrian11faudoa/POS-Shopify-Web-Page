// packages/database/seeds/001_dev_seed.ts
// Development seed: creates a sample store, employees, categories, and products

import type { Knex } from 'knex';
import bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';

export async function seed(knex: Knex): Promise<void> {
  console.log('🌱 Seeding development data...');

  // ─── Store ────────────────────────────────────────────────────────────────
  const storeId = randomUUID();

  await knex('stores').insert({
    id: storeId,
    name: 'SnackStore Demo',
    slug: 'snackstore-demo',
    phone: '+52 442 123 4567',
    email: 'demo@snackstore.mx',
    timezone: 'America/Mexico_City',
    currency: 'MXN',
    address: JSON.stringify({
      line1: 'Av. Constituyentes 123',
      city: 'Querétaro',
      state: 'Querétaro',
      postalCode: '76000',
      country: 'MX',
    }),
    settings: JSON.stringify({
      taxRate: 0.16,
      taxIncluded: false,
      receiptFooter: '¡Gracias por tu compra! Visítanos de nuevo.',
      autoConfirmOrders: true,
      preparationTimeMinutes: 15,
      deliveryRadiusKm: 5,
      minimumOrderAmount: 50,
      openingHours: [
        { dayOfWeek: 1, openTime: '08:00', closeTime: '21:00', isClosed: false },
        { dayOfWeek: 2, openTime: '08:00', closeTime: '21:00', isClosed: false },
        { dayOfWeek: 3, openTime: '08:00', closeTime: '21:00', isClosed: false },
        { dayOfWeek: 4, openTime: '08:00', closeTime: '21:00', isClosed: false },
        { dayOfWeek: 5, openTime: '08:00', closeTime: '22:00', isClosed: false },
        { dayOfWeek: 6, openTime: '09:00', closeTime: '22:00', isClosed: false },
        { dayOfWeek: 0, openTime: '10:00', closeTime: '20:00', isClosed: false },
      ],
    }),
    is_active: true,
  });

  console.log(`✅ Store created: ${storeId}`);

  // ─── Employees ────────────────────────────────────────────────────────────
  const pinHash = await bcrypt.hash('1234', 10);
  const passwordHash = await bcrypt.hash('Admin123!', 10);

  const employeeIds = {
    owner: randomUUID(),
    manager: randomUUID(),
    cashier: randomUUID(),
    kitchen: randomUUID(),
  };

  await knex('employees').insert([
    {
      id: employeeIds.owner,
      store_id: storeId,
      first_name: 'María',
      last_name: 'García',
      email: 'owner@snackstore.mx',
      role: 'OWNER',
      pin_hash: passwordHash, // Owner uses password for full login
      permissions: JSON.stringify([
        'orders:read', 'orders:write', 'orders:cancel', 'orders:refund',
        'products:read', 'products:write', 'inventory:read', 'inventory:write',
        'reports:read', 'employees:read', 'employees:write', 'settings:read', 'settings:write',
        'cash_register:open', 'cash_register:close', 'discounts:apply',
        'suppliers:read', 'suppliers:write',
      ]),
      is_active: true,
    },
    {
      id: employeeIds.manager,
      store_id: storeId,
      first_name: 'Carlos',
      last_name: 'López',
      email: 'manager@snackstore.mx',
      role: 'MANAGER',
      pin_hash: await bcrypt.hash('2345', 10),
      permissions: JSON.stringify([
        'orders:read', 'orders:write', 'orders:cancel', 'orders:refund',
        'products:read', 'products:write', 'inventory:read', 'inventory:write',
        'reports:read', 'employees:read', 'settings:read',
        'cash_register:open', 'cash_register:close', 'discounts:apply', 'suppliers:read',
      ]),
      is_active: true,
    },
    {
      id: employeeIds.cashier,
      store_id: storeId,
      first_name: 'Ana',
      last_name: 'Martínez',
      email: 'cashier@snackstore.mx',
      role: 'CASHIER',
      pin_hash: await bcrypt.hash('3456', 10),
      permissions: JSON.stringify([
        'orders:read', 'orders:write', 'products:read', 'inventory:read',
        'cash_register:open', 'cash_register:close', 'discounts:apply',
      ]),
      is_active: true,
    },
    {
      id: employeeIds.kitchen,
      store_id: storeId,
      first_name: 'Juan',
      last_name: 'Pérez',
      email: 'kitchen@snackstore.mx',
      role: 'KITCHEN',
      pin_hash: await bcrypt.hash('4567', 10),
      permissions: JSON.stringify(['orders:read', 'orders:write', 'inventory:read']),
      is_active: true,
    },
  ]);

  console.log('✅ Employees created (PINs: owner=1234/Admin123!, cashier=3456, kitchen=4567)');

  // ─── Categories ───────────────────────────────────────────────────────────
  const categories = [
    { id: randomUUID(), name: 'Chips & Crisps', slug: 'chips-crisps', sort_order: 0 },
    { id: randomUUID(), name: 'Candy & Sweets', slug: 'candy-sweets', sort_order: 1 },
    { id: randomUUID(), name: 'Beverages', slug: 'beverages', sort_order: 2 },
    { id: randomUUID(), name: 'Hot Snacks', slug: 'hot-snacks', sort_order: 3 },
    { id: randomUUID(), name: 'Healthy Options', slug: 'healthy', sort_order: 4 },
  ];

  await knex('categories').insert(
    categories.map(c => ({ ...c, store_id: storeId, is_active: true }))
  );

  console.log('✅ Categories created');

  const catMap = Object.fromEntries(categories.map(c => [c.slug, c.id]));

  // ─── Products ─────────────────────────────────────────────────────────────
  const products = [
    {
      id: randomUUID(),
      category_id: catMap['chips-crisps'],
      name: 'Sabritas Originales',
      slug: 'sabritas-originales',
      description: 'Las papas fritas clásicas mexicanas, crujientes y perfectamente saladas.',
      base_price: 25.00,
      is_featured: true,
      tags: ['popular', 'salty', 'chips'],
      variants: [
        { name: 'Pequeño (50g)', price: 15.00, sku: 'SAB-S', barcode: '7501030491016', qty: 50 },
        { name: 'Mediano (100g)', price: 25.00, sku: 'SAB-M', barcode: '7501030491023', qty: 40 },
        { name: 'Grande (200g)', price: 45.00, sku: 'SAB-L', barcode: '7501030491030', qty: 25 },
      ],
      modifierGroups: [],
    },
    {
      id: randomUUID(),
      category_id: catMap['hot-snacks'],
      name: 'Elote Preparado',
      slug: 'elote-preparado',
      description: 'Elote en vaso con mantequilla, mayonesa, queso y chile. ¡El sabor de México!',
      base_price: 45.00,
      is_featured: true,
      tags: ['hot', 'mexican', 'popular'],
      variants: [
        { name: 'Regular', price: 45.00, sku: 'ELO-R', barcode: null, qty: 999 },
        { name: 'Grande', price: 60.00, sku: 'ELO-G', barcode: null, qty: 999 },
      ],
      modifierGroups: [
        {
          name: 'Extras',
          required: false,
          minSelections: 0,
          maxSelections: 3,
          modifiers: [
            { name: 'Extra Chile', priceAdjustment: 0, isDefault: false },
            { name: 'Extra Mayonesa', priceAdjustment: 0, isDefault: false },
            { name: 'Extra Queso', priceAdjustment: 5, isDefault: false },
            { name: 'Limón', priceAdjustment: 0, isDefault: true },
          ],
        },
        {
          name: 'Tipo de Chile',
          required: false,
          minSelections: 0,
          maxSelections: 1,
          modifiers: [
            { name: 'Tajín', priceAdjustment: 0, isDefault: true },
            { name: 'Chile en Polvo', priceAdjustment: 0, isDefault: false },
            { name: 'Valentina', priceAdjustment: 0, isDefault: false },
          ],
        },
      ],
    },
    {
      id: randomUUID(),
      category_id: catMap['beverages'],
      name: 'Agua Fresca',
      slug: 'agua-fresca',
      description: 'Aguas frescas artesanales preparadas diariamente.',
      base_price: 30.00,
      is_featured: false,
      tags: ['drink', 'fresh', 'cold'],
      variants: [
        { name: 'Horchata 500ml', price: 30.00, sku: 'AGA-HOR', barcode: null, qty: 20 },
        { name: 'Jamaica 500ml', price: 30.00, sku: 'AGA-JAM', barcode: null, qty: 20 },
        { name: 'Tamarindo 500ml', price: 30.00, sku: 'AGA-TAM', barcode: null, qty: 15 },
        { name: 'Pepino Limón 500ml', price: 32.00, sku: 'AGA-PEL', barcode: null, qty: 15 },
      ],
      modifierGroups: [
        {
          name: 'Tamaño',
          required: false,
          minSelections: 0,
          maxSelections: 1,
          modifiers: [
            { name: 'Sin hielo', priceAdjustment: 0, isDefault: false },
            { name: 'Poco hielo', priceAdjustment: 0, isDefault: false },
            { name: 'Normal (con hielo)', priceAdjustment: 0, isDefault: true },
          ],
        },
      ],
    },
    {
      id: randomUUID(),
      category_id: catMap['candy-sweets'],
      name: 'Dulces Surtidos',
      slug: 'dulces-surtidos',
      description: 'Bolsa con selección de los mejores dulces mexicanos.',
      base_price: 35.00,
      is_featured: false,
      tags: ['candy', 'sweet', 'mexican'],
      variants: [
        { name: '100g', price: 35.00, sku: 'DUL-100', barcode: null, qty: 30 },
        { name: '200g', price: 65.00, sku: 'DUL-200', barcode: null, qty: 20 },
      ],
      modifierGroups: [],
    },
    {
      id: randomUUID(),
      category_id: catMap['healthy'],
      name: 'Fruta Fresca',
      slug: 'fruta-fresca',
      description: 'Mix de frutas de temporada, frescas y sin conservadores.',
      base_price: 55.00,
      is_featured: true,
      tags: ['healthy', 'fresh', 'fruit'],
      variants: [
        { name: 'Chico', price: 35.00, sku: 'FRU-CH', barcode: null, qty: 15 },
        { name: 'Mediano', price: 55.00, sku: 'FRU-ME', barcode: null, qty: 15 },
        { name: 'Grande', price: 80.00, sku: 'FRU-GR', barcode: null, qty: 10 },
      ],
      modifierGroups: [
        {
          name: 'Extras',
          required: false,
          minSelections: 0,
          maxSelections: 2,
          modifiers: [
            { name: 'Chamoy', priceAdjustment: 5, isDefault: false },
            { name: 'Tajín', priceAdjustment: 0, isDefault: false },
            { name: 'Chile Piquín', priceAdjustment: 0, isDefault: false },
          ],
        },
      ],
    },
  ];

  for (const product of products) {
    await knex('products').insert({
      id: product.id,
      store_id: storeId,
      category_id: product.category_id,
      name: product.name,
      slug: product.slug,
      description: product.description,
      image_urls: JSON.stringify([]),
      base_price: product.base_price,
      is_active: true,
      is_featured: product.is_featured,
      track_inventory: true,
      allow_backorder: false,
      tags: JSON.stringify(product.tags),
      metafields: '{}',
    });

    for (const variant of product.variants) {
      const variantId = randomUUID();
      await knex('product_variants').insert({
        id: variantId,
        product_id: product.id,
        name: variant.name,
        sku: variant.sku ?? null,
        barcode: variant.barcode ?? null,
        price: variant.price,
        inventory_quantity: variant.qty,
        low_stock_threshold: 5,
        is_active: true,
        options: '{}',
      });

      await knex('inventory_items').insert({
        store_id: storeId,
        variant_id: variantId,
        quantity: variant.qty,
        reserved_quantity: 0,
        low_stock_threshold: 5,
        reorder_point: 10,
        reorder_quantity: 50,
      });
    }

    for (const [gIdx, group] of product.modifierGroups.entries()) {
      const [mg] = await knex('modifier_groups').insert({
        product_id: product.id,
        name: group.name,
        required: group.required,
        min_selections: group.minSelections,
        max_selections: group.maxSelections,
        sort_order: gIdx,
      }).returning('*');

      for (const [mIdx, mod] of group.modifiers.entries()) {
        await knex('modifiers').insert({
          group_id: mg.id,
          name: mod.name,
          price_adjustment: mod.priceAdjustment,
          is_default: mod.isDefault,
          is_active: true,
          sort_order: mIdx,
        });
      }
    }
  }

  console.log('✅ Products, variants, and inventory created');

  // ─── Sample Coupon ────────────────────────────────────────────────────────
  await knex('coupons').insert({
    store_id: storeId,
    code: 'WELCOME20',
    description: '20% discount for new customers',
    type: 'PERCENTAGE',
    value: 20,
    minimum_order_amount: 100,
    usage_limit: 100,
    per_customer_limit: 1,
    is_active: true,
  });

  await knex('coupons').insert({
    store_id: storeId,
    code: 'SNACK10',
    description: '$10 off any order',
    type: 'FIXED_AMOUNT',
    value: 10,
    minimum_order_amount: 50,
    is_active: true,
  });

  console.log('✅ Coupons created: WELCOME20, SNACK10');

  // ─── Summary ─────────────────────────────────────────────────────────────
  console.log('\n🎉 Seed complete!');
  console.log('━'.repeat(50));
  console.log(`Store ID:    ${storeId}`);
  console.log('Login URL:   http://localhost:3003');
  console.log('Credentials: owner@snackstore.mx / Admin123!');
  console.log('POS PIN:     1234 (owner), 3456 (cashier)');
  console.log('━'.repeat(50));
}
