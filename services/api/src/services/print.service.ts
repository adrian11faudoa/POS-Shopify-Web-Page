// services/api/src/services/print.service.ts
// Thermal receipt printer support: Star Micronics, Epson ESC/POS, network/USB

import { createLogger } from '../lib/logger';
import { db } from '../lib/database';
import type { Order } from '@snackpos/types';

const logger = createLogger('print.service');

// ─── ESC/POS Command Builder ──────────────────────────────────────────────────

class EscPosBuilder {
  private data: number[] = [];

  // ESC/POS constants
  private static readonly ESC = 0x1b;
  private static readonly GS = 0x1d;
  private static readonly LF = 0x0a;
  private static readonly NUL = 0x00;

  init(): this {
    this.data.push(EscPosBuilder.ESC, 0x40); // Initialize printer
    return this;
  }

  text(str: string): this {
    for (const char of str) {
      this.data.push(char.charCodeAt(0));
    }
    return this;
  }

  newline(count = 1): this {
    for (let i = 0; i < count; i++) this.data.push(EscPosBuilder.LF);
    return this;
  }

  bold(on: boolean): this {
    this.data.push(EscPosBuilder.ESC, 0x45, on ? 0x01 : 0x00);
    return this;
  }

  doubleHeight(on: boolean): this {
    this.data.push(EscPosBuilder.ESC, 0x21, on ? 0x10 : 0x00);
    return this;
  }

  center(): this {
    this.data.push(EscPosBuilder.ESC, 0x61, 0x01);
    return this;
  }

  left(): this {
    this.data.push(EscPosBuilder.ESC, 0x61, 0x00);
    return this;
  }

  right(): this {
    this.data.push(EscPosBuilder.ESC, 0x61, 0x02);
    return this;
  }

  divider(width = 42, char = '-'): this {
    this.text(char.repeat(width)).newline();
    return this;
  }

  /** Print two-column line: left text, right text, total width */
  twoColumn(left: string, right: string, width = 42): this {
    const spaces = Math.max(1, width - left.length - right.length);
    this.text(left + ' '.repeat(spaces) + right).newline();
    return this;
  }

  cut(): this {
    // Full cut
    this.data.push(EscPosBuilder.GS, 0x56, 0x00);
    return this;
  }

  openCashDrawer(): this {
    // Pulse pin 2 (standard cash drawer)
    this.data.push(EscPosBuilder.ESC, 0x70, 0x00, 0x19, 0x78);
    return this;
  }

  build(): Buffer {
    return Buffer.from(this.data);
  }
}

// ─── Receipt Builder ─────────────────────────────────────────────────────────

function buildReceiptBuffer(order: Order, storeName: string, storeAddress: string, footer: string): Buffer {
  const printer = new EscPosBuilder().init();
  const width = 42;
  const currency = 'MXN';
  const fmt = (n: number) => `$${n.toFixed(2)}`;

  // Header
  printer
    .center()
    .bold(true)
    .doubleHeight(true)
    .text(storeName.toUpperCase())
    .newline()
    .doubleHeight(false)
    .bold(false)
    .text(storeAddress)
    .newline()
    .newline()
    .left()
    .divider(width);

  // Order info
  printer
    .twoColumn('Order:', order.orderNumber, width)
    .twoColumn('Type:', order.fulfillmentType, width)
    .twoColumn('Date:', new Date(order.createdAt).toLocaleString('es-MX', {
      day: '2-digit', month: '2-digit', year: '2-digit',
      hour: '2-digit', minute: '2-digit',
    }), width);

  if (order.customerName) {
    printer.twoColumn('Customer:', order.customerName, width);
  }
  if (order.tableNumber) {
    printer.twoColumn('Table:', order.tableNumber, width);
  }

  printer.divider(width);

  // Items
  for (const item of order.items) {
    if (item.status === 'CANCELLED') continue;

    const itemTotal = fmt(item.total);
    const itemLine = `${item.quantity}x ${item.name}`;
    const truncated = itemLine.length + itemTotal.length > width
      ? itemLine.slice(0, width - itemTotal.length - 1)
      : itemLine;

    printer.twoColumn(truncated, itemTotal, width);

    if (item.variantName) {
      printer.text(`   ${item.variantName}`).newline();
    }

    const modifiers = item.modifiers as Array<{ name: string; priceAdjustment: number }>;
    for (const mod of modifiers ?? []) {
      const modLine = `   + ${mod.name}`;
      const modPrice = mod.priceAdjustment !== 0 ? fmt(mod.priceAdjustment) : '';
      if (modPrice) {
        printer.twoColumn(modLine, modPrice, width);
      } else {
        printer.text(modLine).newline();
      }
    }

    if (item.notes) {
      printer.text(`   * ${item.notes}`).newline();
    }
  }

  printer.divider(width);

  // Totals
  printer.twoColumn('Subtotal:', fmt(order.subtotal), width);

  if (order.discountAmount > 0) {
    printer.twoColumn(
      `Discount${order.couponCode ? ` (${order.couponCode})` : ''}:`,
      `-${fmt(order.discountAmount)}`,
      width
    );
  }

  if (order.taxAmount > 0) {
    printer.twoColumn('Tax (IVA 16%):', fmt(order.taxAmount), width);
  }

  if (order.deliveryFee > 0) {
    printer.twoColumn('Delivery:', fmt(order.deliveryFee), width);
  }

  if (order.tip > 0) {
    printer.twoColumn('Tip:', fmt(order.tip), width);
  }

  printer.divider(width);

  printer
    .bold(true)
    .twoColumn('TOTAL:', fmt(order.total), width)
    .bold(false);

  // Payments
  for (const payment of order.payments ?? []) {
    if (payment.status === 'CAPTURED') {
      printer.twoColumn(`  ${payment.method}:`, fmt(payment.amount), width);
      if (payment.cashTendered) {
        printer.twoColumn('  Cash tendered:', fmt(payment.cashTendered), width);
        printer.twoColumn('  Change:', fmt(payment.cashChange ?? 0), width);
      }
    }
  }

  printer.divider(width);

  // Notes
  if (order.notes) {
    printer.center().text('Note:').newline().text(order.notes).newline().left();
    printer.divider(width);
  }

  // Footer
  printer
    .center()
    .text(footer || 'Thank you for your purchase!')
    .newline()
    .text('snackpos.dev')
    .newline()
    .newline()
    .newline()
    .cut();

  if (order.type === 'POS') {
    printer.openCashDrawer();
  }

  return printer.build();
}

// ─── Network Printer (TCP/IP) ─────────────────────────────────────────────────

async function printOverNetwork(host: string, port: number, data: Buffer): Promise<void> {
  const net = await import('net');

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Printer timeout connecting to ${host}:${port}`));
    }, 5000);

    socket.connect(port, host, () => {
      socket.write(data, (err) => {
        clearTimeout(timeout);
        socket.end();
        if (err) reject(err);
        else resolve();
      });
    });

    socket.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// ─── Print Service ────────────────────────────────────────────────────────────

export class PrintService {
  async printReceipt(order: Order): Promise<void> {
    const store = await db('stores').where({ id: order.storeId }).first();
    if (!store) throw new Error('Store not found');

    const printerConfig = store.settings?.printerConfig;
    if (!printerConfig) {
      logger.info({ orderId: order.id }, 'No printer configured, skipping print');
      return;
    }

    const receiptData = buildReceiptBuffer(
      order,
      store.name,
      `${store.address?.line1 ?? ''}, ${store.address?.city ?? ''}`,
      store.settings?.receiptFooter ?? ''
    );

    try {
      switch (printerConfig.type) {
        case 'STAR':
        case 'EPSON': {
          if (printerConfig.connectionType === 'NETWORK') {
            const [host, portStr] = printerConfig.address.split(':');
            const port = parseInt(portStr ?? '9100', 10);
            await printOverNetwork(host, port, receiptData);
          } else {
            // USB/Bluetooth: write to device file on Linux
            const fs = await import('fs/promises');
            await fs.writeFile(printerConfig.address, receiptData);
          }
          break;
        }

        case 'CUPS': {
          // Use CUPS lp command for network printers managed by CUPS
          const { exec } = await import('child_process');
          const { promisify } = await import('util');
          const execAsync = promisify(exec);
          const tmpFile = `/tmp/receipt_${order.id}.bin`;
          const fs = await import('fs/promises');
          await fs.writeFile(tmpFile, receiptData);
          await execAsync(`lp -d ${printerConfig.address} ${tmpFile}`);
          await fs.unlink(tmpFile).catch(() => {});
          break;
        }

        default:
          logger.warn({ printerType: printerConfig.type }, 'Unknown printer type');
      }

      logger.info({ orderId: order.id, printerType: printerConfig.type }, 'Receipt printed');
    } catch (err) {
      logger.error({ err, orderId: order.id }, 'Print failed');
      throw err;
    }
  }

  async generateReceiptHtml(order: Order): Promise<string> {
    const store = await db('stores').where({ id: order.storeId }).first();
    const fmt = (n: number) => `$${n.toFixed(2)}`;

    const itemRows = order.items
      .filter(i => i.status !== 'CANCELLED')
      .map(item => {
        const mods = (item.modifiers as Array<{ name: string; priceAdjustment: number }> ?? [])
          .map(m => `<div class="mod">+ ${m.name}${m.priceAdjustment !== 0 ? ` (${fmt(m.priceAdjustment)})` : ''}</div>`)
          .join('');
        return `
          <tr>
            <td>${item.quantity}× ${item.name}${item.variantName ? ` <small>(${item.variantName})</small>` : ''}</td>
            <td class="right">${fmt(item.total)}</td>
          </tr>
          ${mods ? `<tr><td colspan="2">${mods}</td></tr>` : ''}
          ${item.notes ? `<tr><td colspan="2" class="note">📝 ${item.notes}</td></tr>` : ''}
        `;
      }).join('');

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Courier New', monospace; font-size: 12px; width: 80mm; padding: 8px; }
  h1 { font-size: 16px; text-align: center; margin-bottom: 4px; }
  .center { text-align: center; }
  .right { text-align: right; }
  hr { border: none; border-top: 1px dashed #000; margin: 6px 0; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 2px 0; vertical-align: top; }
  .total-row td { font-weight: bold; font-size: 14px; border-top: 1px dashed #000; padding-top: 4px; }
  .mod { color: #555; padding-left: 16px; font-size: 11px; }
  .note { color: #555; font-size: 11px; }
  .footer { text-align: center; margin-top: 8px; font-size: 11px; color: #555; }
  @media print { @page { margin: 0; size: 80mm auto; } }
</style>
</head>
<body>
  <h1>${store?.name ?? 'SnackPOS'}</h1>
  <div class="center">${store?.address?.line1 ?? ''}</div>
  <div class="center">${store?.phone ?? ''}</div>
  <hr>
  <table>
    <tr><td>Order:</td><td class="right">${order.orderNumber}</td></tr>
    <tr><td>Type:</td><td class="right">${order.fulfillmentType}</td></tr>
    <tr><td>Date:</td><td class="right">${new Date(order.createdAt).toLocaleString()}</td></tr>
    ${order.customerName ? `<tr><td>Customer:</td><td class="right">${order.customerName}</td></tr>` : ''}
    ${order.tableNumber ? `<tr><td>Table:</td><td class="right">${order.tableNumber}</td></tr>` : ''}
  </table>
  <hr>
  <table>${itemRows}</table>
  <hr>
  <table>
    <tr><td>Subtotal:</td><td class="right">${fmt(order.subtotal)}</td></tr>
    ${order.discountAmount > 0 ? `<tr><td>Discount:</td><td class="right">-${fmt(order.discountAmount)}</td></tr>` : ''}
    ${order.taxAmount > 0 ? `<tr><td>Tax (IVA):</td><td class="right">${fmt(order.taxAmount)}</td></tr>` : ''}
    ${order.deliveryFee > 0 ? `<tr><td>Delivery:</td><td class="right">${fmt(order.deliveryFee)}</td></tr>` : ''}
    ${order.tip > 0 ? `<tr><td>Tip:</td><td class="right">${fmt(order.tip)}</td></tr>` : ''}
    <tr class="total-row"><td>TOTAL:</td><td class="right">${fmt(order.total)}</td></tr>
  </table>
  ${order.notes ? `<hr><div class="center">Note: ${order.notes}</div>` : ''}
  <hr>
  <div class="footer">${store?.settings?.receiptFooter ?? '¡Gracias por su compra!'}</div>
  <div class="footer" style="margin-top:4px;">snackpos.dev</div>
</body>
</html>`;
  }
}

export const printService = new PrintService();
