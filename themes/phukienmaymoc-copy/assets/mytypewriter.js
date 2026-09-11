(function(){
  const elements = document.querySelectorAll('.typewriter');
  elements.forEach(root => {
    let strings;
    try {
      strings = JSON.parse(root.getAttribute('data-strings'));
      if(!Array.isArray(strings) || strings.length === 0) throw 1;
    } catch(e) {
      strings = [];
    }

    const elText = root.querySelector('.tw-text');
    const TYPE_SPEED = 80;
    const DELETE_SPEED = 40;
    const PAUSE_AFTER = 1000;
    const PAUSE_BETWEEN = 300;
    let sIndex = 0;
    let running = true;

    function typeLoop(){
      const str = strings[sIndex];
      typeChars(str, 0, () => {
        setTimeout(() => {
          deleteChars(str, str.length, () => {
            sIndex = (sIndex + 1) % strings.length;
            setTimeout(typeLoop, PAUSE_BETWEEN);
          });
        }, PAUSE_AFTER);
      });
    }

    function typeChars(str, i, cb){
      if(!running) return;
      if(i <= str.length){
        elText.textContent = str.slice(0, i);
        setTimeout(() => typeChars(str, i+1, cb), TYPE_SPEED);
      } else cb && cb();
    }

    function deleteChars(str, i, cb){
      if(!running) return;
      if(i >= 0){
        elText.textContent = str.slice(0, i);
        setTimeout(() => deleteChars(str, i-1, cb), DELETE_SPEED);
      } else cb && cb();
    }

    typeLoop(); // khởi chạy từng phần tử riêng
  });
})();