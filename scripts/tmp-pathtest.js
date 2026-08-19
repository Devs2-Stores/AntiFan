function assertSafeAbsolutePath(p){
  const norm = p.replace(/\\/g,'/');
  const isAbsWin = /^[a-zA-Z]:\//.test(norm);
  const isAbsPosix = norm.startsWith('/');
  if(!isAbsWin && !isAbsPosix){ return 'THROW non-absolute: '+p; }
  const seg=norm.split('/').filter(Boolean);
  if(seg.includes('..')){ return 'THROW traversal: '+p; }
  return 'PASS: '+p;
}
console.log('1', assertSafeAbsolutePath('file:///c:/work/a')); // annotation folderUri
console.log('2', assertSafeAbsolutePath('c:/work/a'));         // identity folder.path
console.log('3', assertSafeAbsolutePath('file:///../../etc')); // traversal-with-scheme
console.log('4', assertSafeAbsolutePath('/home/user/f'));      // posix abs
console.log('5', assertSafeAbsolutePath('file:///C:/Users'));  // caps uri