// apps/pos/src/components/PaymentModal.tsx
// Cash / card split payment with change calculation

'use client';

import { useState, useRef, useEffect } from 'react';

interface PaymentData {
  payments: Array<{ method: string; amount: number; cashTendered?: number }>;
}

interface PaymentModalProps {
  total: number;
  onSubmit: (data: PaymentData) => Promise<void>;
  onClose: () => void;
}

type PaymentMethod = 'CASH' | 'CARD' | 'SPLIT';

const QUICK_AMOUNTS = [50, 100, 200, 500];

export function PaymentModal({ total, onSubmit, onClose }: PaymentModalProps) {
  const [method, setMethod] = useState<PaymentMethod>('CASH');
  const [cashInput, setCashInput] = useState('');
  const [splitCash, setSplitCash] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const cashRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (method === 'CASH') cashRef.current?.focus();
  }, [method]);

  const cashAmount = parseFloat(cashInput) || 0;
  const change = method === 'CASH' ? Math.max(0, cashAmount - total) : 0;
  const splitCashAmount = parseFloat(splitCash) || 0;
  const splitCardAmount = Math.max(0, total - splitCashAmount);

  const isValid = (): boolean => {
    if (method === 'CASH') return cashAmount >= total;
    if (method === 'CARD') return true;
    if (method === 'SPLIT') return splitCashAmount > 0 && splitCashAmount < total;
    return false;
  };

  const handleNumPad = (digit: string) => {
    const target = method === 'SPLIT' ? setSplitCash : setCashInput;
    const current = method === 'SPLIT' ? splitCash : cashInput;

    if (digit === 'DEL') {
      target(current.slice(0, -1));
    } else if (digit === '.') {
      if (!current.includes('.')) target(current + '.');
    } else if (digit === 'C') {
      target('');
    } else {
      // Prevent too many decimal places
      const parts = current.split('.');
      if (parts[1] && parts[1].length >= 2) return;
      target(current + digit);
    }
  };

  const handleSubmit = async () => {
    if (!isValid()) {
      setError('Please enter a valid payment amount.');
      return;
    }

    setSubmitting(true);
    setError('');

    try {
      let payments: PaymentData['payments'];

      if (method === 'CASH') {
        payments = [{ method: 'CASH', amount: total, cashTendered: cashAmount }];
      } else if (method === 'CARD') {
        payments = [{ method: 'CARD', amount: total }];
      } else {
        payments = [
          { method: 'CASH', amount: splitCashAmount, cashTendered: splitCashAmount },
          { method: 'CARD', amount: splitCardAmount },
        ];
      }

      await onSubmit({ payments });
    } catch (err) {
      setError((err as Error).message || 'Payment failed. Please try again.');
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal aria-label="Payment">
      <div className="payment-modal">
        {/* Header */}
        <div className="payment-modal-header">
          <h2 className="payment-title">Collect Payment</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {/* Total */}
        <div className="payment-total">
          <span className="total-label">Total Due</span>
          <span className="total-amount">${total.toFixed(2)}</span>
        </div>

        {/* Method Selector */}
        <div className="method-tabs">
          {(['CASH', 'CARD', 'SPLIT'] as const).map(m => (
            <button
              key={m}
              className={`method-tab ${method === m ? 'active' : ''}`}
              onClick={() => { setMethod(m); setError(''); }}
            >
              {m === 'CASH' ? '💵 Cash' : m === 'CARD' ? '💳 Card' : '🔀 Split'}
            </button>
          ))}
        </div>

        {/* Cash Input */}
        {method === 'CASH' && (
          <div className="cash-section">
            <label className="input-label">Cash Received</label>
            <div className="cash-input-wrapper">
              <span className="cash-prefix">$</span>
              <input
                ref={cashRef}
                type="text"
                inputMode="decimal"
                className="cash-input"
                value={cashInput}
                onChange={e => setCashInput(e.target.value.replace(/[^0-9.]/g, ''))}
                placeholder="0.00"
              />
            </div>
            <div className="quick-amounts">
              {QUICK_AMOUNTS.filter(a => a >= total).concat(
                QUICK_AMOUNTS.filter(a => a < total && a > 0).slice(-1)
              ).slice(0, 4).map(a => (
                <button
                  key={a}
                  className="quick-btn"
                  onClick={() => setCashInput(String(a))}
                >
                  ${a}
                </button>
              ))}
              <button
                className="quick-btn quick-btn--exact"
                onClick={() => setCashInput(total.toFixed(2))}
              >
                Exact
              </button>
            </div>

            {cashAmount >= total && (
              <div className="change-display">
                <span className="change-label">Change</span>
                <span className="change-amount">${change.toFixed(2)}</span>
              </div>
            )}
          </div>
        )}

        {/* Card Section */}
        {method === 'CARD' && (
          <div className="card-section">
            <div className="card-info">
              <div className="card-icon">💳</div>
              <p>Process <strong>${total.toFixed(2)}</strong> on card reader</p>
              <p className="card-hint">Complete payment on the card terminal, then confirm here.</p>
            </div>
          </div>
        )}

        {/* Split Section */}
        {method === 'SPLIT' && (
          <div className="split-section">
            <div className="split-row">
              <label className="input-label">Cash Amount</label>
              <div className="cash-input-wrapper">
                <span className="cash-prefix">$</span>
                <input
                  type="text"
                  inputMode="decimal"
                  className="cash-input cash-input--split"
                  value={splitCash}
                  onChange={e => setSplitCash(e.target.value.replace(/[^0-9.]/g, ''))}
                  placeholder="0.00"
                />
              </div>
            </div>
            {splitCashAmount > 0 && splitCardAmount > 0 && (
              <div className="split-breakdown">
                <div className="split-item">
                  <span>💵 Cash</span>
                  <span>${splitCashAmount.toFixed(2)}</span>
                </div>
                <div className="split-item">
                  <span>💳 Card</span>
                  <span>${splitCardAmount.toFixed(2)}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Numpad for Cash / Split */}
        {(method === 'CASH' || method === 'SPLIT') && (
          <div className="numpad">
            {['7','8','9','4','5','6','1','2','3','.','0','DEL'].map(key => (
              <button
                key={key}
                className={`numpad-key ${key === 'DEL' ? 'numpad-key--del' : ''}`}
                onClick={() => handleNumPad(key)}
              >
                {key === 'DEL' ? '⌫' : key}
              </button>
            ))}
            <button
              className="numpad-key numpad-key--clear"
              onClick={() => handleNumPad('C')}
            >
              C
            </button>
          </div>
        )}

        {error && <div className="payment-error">{error}</div>}

        {/* Actions */}
        <div className="payment-actions">
          <button className="btn-secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            className="btn-charge"
            onClick={handleSubmit}
            disabled={!isValid() || submitting}
          >
            {submitting
              ? '⏳ Processing...'
              : `Charge $${total.toFixed(2)}`}
          </button>
        </div>
      </div>
    </div>
  );
}
