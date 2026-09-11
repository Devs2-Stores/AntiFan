/* Quote request form behaviour for templates/page.quote.liquid.
   Row markup, classes and limits mirror the hoplongtech reference bundle
   (build reference: demo-html/bao-gia/). */
(function () {
  'use strict';

  var MAX_ROWS = 10;

  function directRows(root) {
    var rows = [];
    for (var i = 0; i < root.children.length; i++) {
      var el = root.children[i];
      if (el.classList && el.classList.contains('flex')) rows.push(el);
    }
    return rows;
  }

  // Mirrors the reference form's Alpine state: the info button toggles the .detail
  // panel, clicking outside the row closes it.
  function initFileGuide(scope) {
    if (!scope) return;
    var row = scope.querySelector('.row-file');
    if (!row) return;
    var toggle = row.querySelector('.info-more__button');
    var detail = row.querySelector('.detail');
    if (!toggle || !detail) return;

    function setOpen(open) {
      detail.style.display = open ? '' : 'none';
    }

    toggle.addEventListener('click', function () {
      setOpen(detail.style.display === 'none');
    });

    document.addEventListener('click', function (event) {
      if (detail.style.display === 'none') return;
      if (row.contains(event.target)) return;
      setOpen(false);
    });
  }

  function init(root) {
    var form = root.closest('form');
    initFileGuide(form);
    var template = document.getElementById('quote-product-row');
    var addButton = root.querySelector('.row-button');
    if (!form || !template || !addButton) return;

    var bodyField = form.querySelector('input[name="contact[body]"]');
    var submitButton = form.querySelector('button[type="submit"]');
    if (!bodyField || !submitButton) return;

    function syncAddButton() {
      addButton.style.display = directRows(root).length >= MAX_ROWS ? 'none' : '';
    }

    function addRow() {
      if (directRows(root).length >= MAX_ROWS) return;
      var row = template.content.firstElementChild.cloneNode(true);
      root.insertBefore(row, addButton);
      syncAddButton();
      var firstInput = row.querySelector('input[name="product_name"]');
      if (firstInput) firstInput.focus();
    }

    function removeRow(trigger) {
      var row = trigger.closest('.flex');
      if (!row) return;
      row.parentNode.removeChild(row);
      syncAddButton();
    }

    function serializeRows() {
      var lines = [];
      directRows(root).forEach(function (row, index) {
        var name = row.querySelector('input[name="product_name"]');
        var quantity = row.querySelector('input[name="product_quantity"]');
        if (!name || !quantity) return;
        lines.push((index + 1) + '. ' + name.value.trim() + ' - SL: ' + quantity.value.trim());
      });
      return lines.join('\n');
    }

    addButton.addEventListener('click', addRow);
    addButton.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        addRow();
      }
    });

    root.addEventListener('click', function (event) {
      var trigger = event.target.closest ? event.target.closest('.remove-row') : null;
      if (trigger) removeRow(trigger);
    });

    form.addEventListener('submit', function () {
      bodyField.value = serializeRows();
      submitButton.disabled = true;
    });

    window.addEventListener('pageshow', function () {
      submitButton.disabled = false;
    });

    syncAddButton();
  }

  document.addEventListener('DOMContentLoaded', function () {
    var root = document.querySelector('.page-form .row-product');
    if (root) init(root);
  });
})();
