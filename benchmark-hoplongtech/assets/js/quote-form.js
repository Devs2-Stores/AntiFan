/**
 * Quote Form Submission & Validation Module
 * Secure, XSS-hardened implementation using textContent & DOM APIs.
 */
export function initQuoteForm() {
  const quoteForm = document.querySelector('.quote-form, #form-quote');
  if (!quoteForm) return;

  quoteForm.addEventListener('submit', (e) => {
    e.preventDefault();
    
    const nameInput = quoteForm.querySelector('[name="name"], #quote-name');
    const phoneInput = quoteForm.querySelector('[name="phone"], #quote-phone');
    const emailInput = quoteForm.querySelector('[name="email"], #quote-email');
    const noteInput = quoteForm.querySelector('[name="note"], #quote-note');

    const name = nameInput ? nameInput.value.trim() : '';
    const phone = phoneInput ? phoneInput.value.trim() : '';
    const email = emailInput ? emailInput.value.trim() : '';
    const note = noteInput ? noteInput.value.trim() : '';

    if (!name || !phone) {
      alert('Vui lòng nhập họ tên và số điện thoại liên hệ.');
      return;
    }

    // Secure notification without innerHTML injection
    const alertBox = document.createElement('div');
    alertBox.className = 'quote-alert-success';
    alertBox.textContent = `Cảm ơn ${name}! Yêu cầu báo giá đã được gửi thành công. Chúng tôi sẽ liên hệ lại qua số ${phone}.`;
    alertBox.style.cssText = 'background: #e8f5e9; color: #2e7d32; padding: 12px; border-radius: 4px; margin-top: 15px; font-weight: 500;';

    const existingAlert = quoteForm.querySelector('.quote-alert-success');
    if (existingAlert) existingAlert.remove();
    
    quoteForm.appendChild(alertBox);
    quoteForm.reset();
  });
}
