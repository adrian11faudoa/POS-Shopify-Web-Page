// services/api/src/services/product.service.ts
// Full product catalog management with Shopify sync

import { db } from '../lib/database';
import { shopifyService } from './shopify.service';
import { AppError } from '../lib/errors';
import { createLogger } from '../lib/logger';
import type { Product } from '@snackpos/types';

const logger = createLogger('product.service');

export class ProductService {
  async list(storeId: string, query: {
    page?: number;
    perPage?: number;
    categoryId?: string;
    search?: string;
    isActive?: boolean;
    isFeatured?: boolean;
    tags?: string;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  }) {
    const { page = 1, perPage = 20, categoryId, search, isActive, isFeatured, tags, sortBy = 'name', sortOrder = 'asc' } = query;

    let q = db('products')
      .where({ store_id: storeId })
      .whereNull('deleted_at');

    if (isActive !== undefined) q = q.where({ is_active: isActive });
    if (isFeatured !== undefined) q = q.where({ is_featured: isFeatured });
    if (categoryId) q = q.where({ category_id: categoryId });
    if (tags) {
      const tagList = tags.split(',').map(t => t.trim());
      q = q.where(builder => {
        for (const tag of tagList) builder.orWhereRaw('? = ANY(tags)', [tag]);
      });
    }
    if (search) {
      q = q.whereRaw(
        `to_tsvector('english', name || ' ' || COALESCE(description,'')) @@ plainto_tsquery('english', ?)`,
        [search]
      );
    }

    const [{ count }] = await q.clone().count('* as count');
    const total = parseInt(count as string, 10);

    const rows = await q
      .orderBy(sortBy, sortOrder)
      .limit(perPage)
      .offset((page - 1) * perPage);

    const products = await Promise.all(rows.map((row: Record<string, unknown>) => this.hydrate(row)));
    return { products, total };
  }

  async getById(productId: string, storeId?: string): Promise<Product> {
    let q = db('products').where({ id: productId }).whereNull('deleted_at');
    if (storeId) q = q.where({ store_id: storeId });
    const row = await q.first();
    if (!row) throw new AppError('NOT_FOUND', 'Product not found', 404);
    return this.hydrate(row);
  }

  async getByBarcode(barcode: string, storeId: string): Promise<{ product: Product; variant: Record<string, unknown> | null }> {
    const variant = await db('product_variants')
      .join('products', 'product_variants.product_id', 'products.id')
      .where('product_variants.barcode', barcode)
      .where('products.store_id', storeId)
      .whereNull('products.deleted_at')
      .where('products.is_active', true)
      .where('product_variants.is_active', true)
      .select('product_variants.*', 'products.id as product_id')
      .first();

    if (variant) {
      const product = await this.getById(variant.product_id, storeId);
      return { product, variant };
    }

    // Try product barcode
    const product = await db('products')
      .where({ barcode, store_id: storeId, is_active: true })
      .whereNull('deleted_at')
      .first();

    if (product) {
      return { product: await this.hydrate(product), variant: null };
    }

    throw new AppError('NOT_FOUND', `No product found with barcode ${barcode}`, 404);
  }

  async create(storeId: string, input: Record<string, unknown>): Promise<Product> {
    return await db.transaction(async (trx) => {
      const slug = await this.generateUniqueSlug(trx, storeId, input.name as string);

      const [product] = await trx('products').insert({
        store_id: storeId,
        category_id: input.categoryId ?? null,
        name: input.name,
        slug,
        description: input.description ?? null,
        image_urls: JSON.stringify(input.imageUrls ?? []),
        base_price: input.basePrice,
        compare_at_price: input.compareAtPrice ?? null,
        sku: input.sku ?? null,
        barcode: input.barcode ?? null,
        is_active: input.isActive ?? true,
        is_featured: input.isFeatured ?? false,
        track_inventory: input.trackInventory ?? true,
        allow_backorder: input.allowBackorder ?? false,
        tags: JSON.stringify(input.tags ?? []),
      }).returning('*');

      // Create variants
      const variants = input.variants as Record<string, unknown>[] ?? [];
      if (variants.length === 0) {
        // Auto-create default variant
        await trx('product_variants').insert({
          product_id: product.id,
          name: 'Default',
          price: input.basePrice,
          inventory_quantity: 0,
          is_active: true,
          options: '{}',
        });
      } else {
        for (const variant of variants) {
          await trx('product_variants').insert({
            product_id: product.id,
            name: variant.name,
            sku: variant.sku ?? null,
            barcode: variant.barcode ?? null,
            price: variant.price,
            compare_at_price: variant.compareAtPrice ?? null,
            inventory_quantity: variant.inventoryQuantity ?? 0,
            low_stock_threshold: variant.lowStockThreshold ?? 5,
            is_active: true,
            options: JSON.stringify(variant.options ?? {}),
          });
        }
      }

      // Create modifier groups
      const modifierGroups = input.modifierGroups as Record<string, unknown>[] ?? [];
      for (const [groupIdx, group] of modifierGroups.entries()) {
        const [mg] = await trx('modifier_groups').insert({
          product_id: product.id,
          name: group.name,
          description: group.description ?? null,
          required: group.required ?? false,
          min_selections: group.minSelections ?? 0,
          max_selections: group.maxSelections ?? 1,
          sort_order: groupIdx,
        }).returning('*');

        const modifiers = group.modifiers as Record<string, unknown>[] ?? [];
        for (const [modIdx, mod] of modifiers.entries()) {
          await trx('modifiers').insert({
            group_id: mg.id,
            name: mod.name,
            price_adjustment: mod.priceAdjustment ?? 0,
            is_default: mod.isDefault ?? false,
            is_active: true,
            sort_order: modIdx,
          });
        }
      }

      // Create inventory records
      const newVariants = await trx('product_variants').where({ product_id: product.id });
      for (const variant of newVariants) {
        await trx('inventory_items').insert({
          store_id: storeId,
          variant_id: variant.id,
          quantity: variant.inventory_quantity,
          reserved_quantity: 0,
          low_stock_threshold: variant.low_stock_threshold,
          reorder_point: 10,
          reorder_quantity: 50,
        });
      }

      return this.hydrate(product);
    });
  }

  async update(productId: string, storeId: string, input: Record<string, unknown>): Promise<Product> {
    const existing = await db('products')
      .where({ id: productId, store_id: storeId })
      .whereNull('deleted_at')
      .first();

    if (!existing) throw new AppError('NOT_FOUND', 'Product not found', 404);

    const updateData: Record<string, unknown> = {};
    if (input.name !== undefined) updateData.name = input.name;
    if (input.description !== undefined) updateData.description = input.description;
    if (input.categoryId !== undefined) updateData.category_id = input.categoryId;
    if (input.basePrice !== undefined) updateData.base_price = input.basePrice;
    if (input.compareAtPrice !== undefined) updateData.compare_at_price = input.compareAtPrice;
    if (input.isActive !== undefined) updateData.is_active = input.isActive;
    if (input.isFeatured !== undefined) updateData.is_featured = input.isFeatured;
    if (input.imageUrls !== undefined) updateData.image_urls = JSON.stringify(input.imageUrls);
    if (input.tags !== undefined) updateData.tags = JSON.stringify(input.tags);
    if (input.barcode !== undefined) updateData.barcode = input.barcode;
    if (input.sku !== undefined) updateData.sku = input.sku;

    await db('products').where({ id: productId }).update(updateData);
    return this.getById(productId, storeId);
  }

  async delete(productId: string, storeId: string): Promise<void> {
    const product = await db('products')
      .where({ id: productId, store_id: storeId })
      .whereNull('deleted_at')
      .first();

    if (!product) throw new AppError('NOT_FOUND', 'Product not found', 404);

    await db('products').where({ id: productId }).update({
      deleted_at: new Date(),
      is_active: false,
    });
  }

  async syncToShopify(productId: string, storeId: string): Promise<void> {
    const product = await this.getById(productId, storeId);
    logger.info({ productId, storeId }, 'Syncing product to Shopify');
    // Implementation: call shopifyService.createOrUpdateProduct(product)
    // Left as extension point since Shopify product creation requires full Admin API setup
  }

  // Called from Shopify webhook handler
  async syncFromShopify(storeId: string, shopifyProduct: Record<string, unknown>): Promise<void> {
    return shopifyService.syncFromShopify(storeId, shopifyProduct);
  }

  private async hydrate(row: Record<string, unknown>): Promise<Product> {
    const [variants, modifierGroups] = await Promise.all([
      db('product_variants')
        .where({ product_id: row.id, is_active: true })
        .orderBy('name'),
      db('modifier_groups')
        .where({ product_id: row.id })
        .orderBy('sort_order'),
    ]);

    const groupsWithMods = await Promise.all(
      modifierGroups.map(async (group: Record<string, unknown>) => {
        const modifiers = await db('modifiers')
          .where({ group_id: group.id, is_active: true })
          .orderBy('sort_order');
        return { ...group, modifiers };
      })
    );

    const parseJson = (v: unknown) => {
      if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } }
      return v;
    };

    return {
      id: row.id as string,
      storeId: row.store_id as string,
      categoryId: row.category_id as string,
      shopifyProductId: row.shopify_product_id as string | null,
      name: row.name as string,
      slug: row.slug as string,
      description: row.description as string | null,
      imageUrls: parseJson(row.image_urls) as string[],
      basePrice: parseFloat(row.base_price as string),
      compareAtPrice: row.compare_at_price ? parseFloat(row.compare_at_price as string) : null,
      sku: row.sku as string | null,
      barcode: row.barcode as string | null,
      isActive: row.is_active as boolean,
      isFeatured: row.is_featured as boolean,
      trackInventory: row.track_inventory as boolean,
      allowBackorder: row.allow_backorder as boolean,
      tags: parseJson(row.tags) as string[],
      metafields: parseJson(row.metafields) as Record<string, unknown>,
      variants: variants.map((v: Record<string, unknown>) => ({
        id: v.id,
        productId: v.product_id,
        shopifyVariantId: v.shopify_variant_id,
        name: v.name,
        sku: v.sku,
        barcode: v.barcode,
        price: parseFloat(v.price as string),
        compareAtPrice: v.compare_at_price ? parseFloat(v.compare_at_price as string) : null,
        inventoryQuantity: v.inventory_quantity,
        lowStockThreshold: v.low_stock_threshold,
        isActive: v.is_active,
        options: parseJson(v.options),
        createdAt: v.created_at,
        updatedAt: v.updated_at,
      })),
      modifierGroups: groupsWithMods.map((g: Record<string, unknown>) => ({
        id: g.id,
        productId: g.product_id,
        name: g.name,
        description: g.description,
        required: g.required,
        minSelections: g.min_selections,
        maxSelections: g.max_selections,
        sortOrder: g.sort_order,
        modifiers: (g.modifiers as Record<string, unknown>[]).map(m => ({
          id: m.id,
          groupId: m.group_id,
          name: m.name,
          priceAdjustment: parseFloat(m.price_adjustment as string),
          isDefault: m.is_default,
          isActive: m.is_active,
          sortOrder: m.sort_order,
          inventoryVariantId: m.inventory_variant_id,
          createdAt: m.created_at,
          updatedAt: m.updated_at,
        })),
        createdAt: g.created_at,
        updatedAt: g.updated_at,
      })),
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
      deletedAt: row.deleted_at as Date | null,
    } as Product;
  }

  private async generateUniqueSlug(trx: typeof db, storeId: string, name: string): Promise<string> {
    const base = name.toLowerCase().normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 90);

    let slug = base;
    let attempt = 0;
    while (true) {
      const existing = await trx('products').where({ store_id: storeId, slug }).whereNull('deleted_at').first();
      if (!existing) return slug;
      attempt++;
      slug = `${base}-${attempt}`;
    }
  }
}

export const productService = new ProductService();
