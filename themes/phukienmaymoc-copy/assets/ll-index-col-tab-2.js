//var useWishlist = {{settings.loomline_header_wishlist_show}} || false;
Loomline.IndexCollectionTab2 = {
		init: function() {
			var that = this;
      that.Loomline_IndexCollectionTab2();
		},
  Loomline_IndexCollectionTab2: function(){
		var first_id = $('.loomline-index-col-tab-2 .list-title li:first').attr('data-id'),
				first_handle = $('.loomline-index-col-tab-2 .list-title li:first').attr('data-handle');
		function render_pro(id,handle){
			var url = "/collections/"+ handle + "?view=index-tab-2";
			$.ajax(url, { type: 'POST', success: function (data) { 
        $("#" + id).html(data);
        $('#'+ id +' .pro-item').addClass('has-view');
        if (localStorage.getItem("list_wishlist") === null) {
      		var arrWishlist_tab = []
        }else{
          var arrWishlist_tab = localStorage.getItem('list_wishlist').split(',');
        }
        $('.js-wishlist-count').html(arrWishlist_tab.length)
        $('body .js-product__wishlist').each(function(){
        const index = arrWishlist_tab.indexOf($(this).data('handle'));
        if (index > -1) {  
          $(this).addClass('active');
          $(this).attr("data-tooltip","Đã yêu thích")
        }
      })
      } } );
      
		}
		$('.loomline-index-col-tab-2 .list-title li:first').addClass('active');
		if(first_handle != ''){
			$('.loomline-index-col-tab-2 .tab-detail #' + first_id).addClass('show');
			render_pro(first_id,first_handle);
		}
		$('.loomline-index-col-tab-2 .list-title li').click(function(){
      const $this = $(this);
		var data_id = $this.attr('data-id'), data_handle = $this.attr('data-handle'), length = $('.loomline-index-col-tab-2 .tab-detail .detail#'+data_id+' .pro-item').length;
			if(data_handle != '' && length < 1){
				render_pro(data_id,data_handle);
			}else{
        /*if($('#'+ data_id +' .pro-item').hasClass('has-view')){
          $('#'+ data_id +' .pro-item').removeClass('has-view').addClass('viewed');
        }*/
      }
			$('.loomline-index-col-tab-2 .list-title li').removeClass('active');
			$this.addClass('active');
			$('.loomline-index-col-tab-2 .tab-detail .detail').removeClass('show');
			$('.loomline-index-col-tab-2 .tab-detail #' + data_id).addClass('show');
		})
	},
};
(function() {
  Loomline.IndexCollectionTab2.init();
})();





