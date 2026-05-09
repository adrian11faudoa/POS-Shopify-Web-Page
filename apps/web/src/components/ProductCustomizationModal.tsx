// apps/web/src/components/ProductCustomizationModal.tsx
// Multi-step product customization: variant → modifiers → quantity → add to cart

'use client';

import { useState, useMemo } from 'react';
import type { Product, ProductVariant, ModifierGroup, Modifier } from '@snackpos/types';
import type { CartItem } from '@/stores/cart.store';

interface ProductCustomizationModalProps {
  product: Product;
  onAdd: (item: Omit<CartItem, 'id' | 'quantity'> & { quantity: number }) => void;
  onClose: () => void;
}

interface SelectedModifiers {
  [groupId: string]: string[]; // modifierId[]
}

export function ProductCustomizationModal({ product, onAdd, onClose }: ProductCustomizationModalProps) {
  const [selectedVariant, setSelectedVariant] = useState<ProductVariant>(product.variants[0]);
  const [selectedModifiers, setSelectedModifiers] = useState<SelectedModifiers>(() => {
    // Pre-select defaults
    const defaults: SelectedModifiers = {};
    for (const group of product.modifierGroups) {
      const defaultMods = group.modifiers.filter(m => m.isDefault && m.isActive).map(m => m.id);
      if (defaultMods.length > 0) defaults[group.id] = defaultMods;
    }
    return defaults;
  });
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState('');

  // Calculate total price
  const modifierTotal = useMemo(() => {
    let total = 0;
    for (const group of product.modifierGroups) {
      const selected = selectedModifiers[group.id] ?? [];
      for (const modId of selected) {
        const mod = group.modifiers.find(m => m.id === modId);
        if (mod) total += mod.priceAdjustment;
      }
    }
    return total;
  }, [product.modifierGroups, selectedModifiers]);

  const effectivePrice = selectedVariant.price + modifierTotal;
  const lineTotal = effectivePrice * quantity;

  const toggleModifier = (group: ModifierGroup, modifier: Modifier) => {
    setSelectedModifiers(prev => {
      const current = prev[group.id] ?? [];

      if (group.maxSelections === 1) {
        // Radio: toggle or deselect if already selected
        return {
          ...prev,
          [group.id]: current.includes(modifier.id) ? [] : [modifier.id],
        };
      }

      // Checkbox: add or remove
      if (current.includes(modifier.id)) {
        return { ...prev, [group.id]: current.filter(id => id !== modifier.id) };
      }

      if (current.length >= group.maxSelections) {
        // Max reached: don't add
        return prev;
      }

      return { ...prev, [group.id]: [...current, modifier.id] };
    });
  };

  const isValid = useMemo(() => {
    for (const group of product.modifierGroups) {
      if (group.required) {
        const selected = selectedModifiers[group.id] ?? [];
        if (selected.length < group.minSelections) return false;
      }
    }
    return true;
  }, [product.modifierGroups, selectedModifiers]);

  const handleAdd = () => {
    const modifiers = product.modifierGroups.flatMap(group =>
      (selectedModifiers[group.id] ?? []).map(modId => {
        const mod = group.modifiers.find(m => m.id === modId)!;
        return { modifierId: mod.id, name: mod.name, priceAdjustment: mod.priceAdjustment };
      })
    );

    onAdd({
      productId: product.id,
      variantId: selectedVariant.id,
      name: product.name,
      variantName: selectedVariant.name !== 'Default' ? selectedVariant.name : null,
      price: effectivePrice,
      imageUrl: product.imageUrls[0] ?? null,
      modifiers,
      notes,
      quantity,
    });
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal aria-labelledby="modal-title">
      <div className="customization-modal">
        {/* Header */}
        <div className="modal-header">
          <div className="modal-product-img">
            {product.imageUrls[0] ? (
              <img src={product.imageUrls[0]} alt={product.name} />
            ) : (
              <div className="img-placeholder">🍿</div>
            )}
          </div>
          <div className="modal-product-info">
            <h2 id="modal-title">{product.name}</h2>
            {product.description && <p className="modal-desc">{product.description}</p>}
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="modal-body">
          {/* Variant Selector */}
          {product.variants.length > 1 && (
            <div className="customization-section">
              <div className="section-header">
                <h3>Size / Variant</h3>
                <span className="required-badge">Required</span>
              </div>
              <div className="variant-options">
                {product.variants.filter(v => v.isActive).map(variant => (
                  <label key={variant.id} className="variant-option">
                    <input
                      type="radio"
                      name="variant"
                      checked={selectedVariant.id === variant.id}
                      onChange={() => setSelectedVariant(variant)}
                      className="sr-only"
                    />
                    <div className={`variant-card ${selectedVariant.id === variant.id ? 'selected' : ''}`}>
                      <span className="variant-name">{variant.name}</span>
                      <span className="variant-price">${variant.price.toFixed(2)}</span>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Modifier Groups */}
          {product.modifierGroups.map(group => {
            const selected = selectedModifiers[group.id] ?? [];
            const maxReached = selected.length >= group.maxSelections && group.maxSelections > 1;

            return (
              <div key={group.id} className="customization-section">
                <div className="section-header">
                  <h3>{group.name}</h3>
                  <span className={group.required ? 'required-badge' : 'optional-badge'}>
                    {group.required ? 'Required' : 'Optional'}
                    {group.maxSelections > 1 ? ` (up to ${group.maxSelections})` : ''}
                  </span>
                </div>

                {group.description && <p className="section-desc">{group.description}</p>}

                <div className="modifier-options">
                  {group.modifiers.filter(m => m.isActive).map(modifier => {
                    const isSelected = selected.includes(modifier.id);
                    const isDisabled = !isSelected && maxReached;

                    return (
                      <label
                        key={modifier.id}
                        className={`modifier-option ${isSelected ? 'selected' : ''} ${isDisabled ? 'disabled' : ''}`}
                      >
                        <input
                          type={group.maxSelections === 1 ? 'radio' : 'checkbox'}
                          name={`group-${group.id}`}
                          checked={isSelected}
                          onChange={() => !isDisabled && toggleModifier(group, modifier)}
                          disabled={isDisabled}
                          className="sr-only"
                        />
                        <div className="modifier-content">
                          <span className="modifier-name">{modifier.name}</span>
                          {modifier.priceAdjustment !== 0 && (
                            <span className={`modifier-price ${modifier.priceAdjustment > 0 ? 'positive' : 'negative'}`}>
                              {modifier.priceAdjustment > 0 ? '+' : ''}${modifier.priceAdjustment.toFixed(2)}
                            </span>
                          )}
                        </div>
                        <span className="modifier-check">{isSelected ? '✓' : ''}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* Notes */}
          <div className="customization-section">
            <div className="section-header">
              <h3>Special Instructions</h3>
              <span className="optional-badge">Optional</span>
            </div>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value.slice(0, 200))}
              placeholder="E.g., no onions, extra sauce..."
              className="notes-textarea"
              rows={2}
            />
            <div className="char-count">{notes.length}/200</div>
          </div>
        </div>

        {/* Footer */}
        <div className="modal-footer">
          <div className="quantity-control">
            <button
              className="qty-btn"
              onClick={() => setQuantity(q => Math.max(1, q - 1))}
              aria-label="Decrease quantity"
              disabled={quantity <= 1}
            >
              −
            </button>
            <span className="qty-value">{quantity}</span>
            <button
              className="qty-btn"
              onClick={() => setQuantity(q => Math.min(99, q + 1))}
              aria-label="Increase quantity"
            >
              +
            </button>
          </div>

          <button
            className="btn-add-cart"
            onClick={handleAdd}
            disabled={!isValid}
          >
            Add {quantity > 1 ? `${quantity} × ` : ''}to Cart — ${lineTotal.toFixed(2)}
          </button>
        </div>
      </div>
    </div>
  );
}
