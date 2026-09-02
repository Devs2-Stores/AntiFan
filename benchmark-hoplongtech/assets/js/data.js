/**
 * Hoplongtech Data Model (Haravan / Liquid Compatible)
 * Structured for direct 1-1 serialization to Liquid Theme Objects & Metafields.
 */
window.HOPLONG_DATA = {
  shop: {
    name: "Hoplongtech.com",
    company: "Công ty Cổ phần Công nghệ Hợp Long",
    hotline: "1800 6345",
    email: "contact@hoplongtech.com",
    branchesCount: 6,
    logoUrl: "https://img.hoplongtech.com/hoplong/uploads/logo-hlt-2024.png"
  },

  menuItems: [
    { title: "Các thương hiệu", url: "/brands", icon: "icon-brand" },
    { title: "Đặt hàng nhanh", url: "/dat-hang-nhanh", icon: "icon-order" },
    { title: "Yêu cầu báo giá", url: "/bao-gia", icon: "icon-quote" },
    { title: "Tracking Order", url: "/my-account/tracking-order", icon: "icon-track" },
    { title: "Check bảo hành", url: "/tra-cuu-bao-hanh", icon: "icon-warranty" },
    { title: "Tài liệu kỹ thuật", url: "/tai-lieu-ky-thuat", icon: "icon-doc" },
    { title: "Tin tức", url: "/news", icon: "icon-news" },
    { title: "Flash Sale", url: "/flash-sale", icon: "icon-flash" }
  ],

  categories: [
    { title: "Cảm biến", handle: "cam-bien", url: "/category/cam-bien" },
    { title: "Chuyển mạch/ Nút nhấn", handle: "chuyen-mach-nut-nhan", url: "/category/chuyen-mach-nut-nhan" },
    { title: "Đèn báo", handle: "den-bao", url: "/category/den-bao" },
    { title: "Đồng hồ đo", handle: "dong-ho-do", url: "/category/dong-ho-do" },
    { title: "Bộ điều khiển nhiệt độ", handle: "bo-dieu-khien-nhiet-do", url: "/category/bo-dieu-khien-nhiet-do" },
    { title: "Biến tần", handle: "bien-tan", url: "/category/bien-tan" },
    { title: "Khởi động mềm", handle: "khoi-dong-mem", url: "/category/khoi-dong-mem" },
    { title: "PLC/ HMI", handle: "plc-hmi", url: "/category/plc-hmi" },
    { title: "Relay", handle: "relay", url: "/category/relay" },
    { title: "Thiết bị đóng cắt", handle: "thiet-bi-dong-cat", url: "/category/thiet-bi-dong-cat" }
  ],

  brands: [
    { name: "Schneider Electric", image: "https://img.hoplongtech.com/hoplong/uploads/bien-tan-se.jpg", url: "/brands/schneider-electric" },
    { name: "Giga Electric", image: "https://img.hoplongtech.com/hoplong/uploads/nut-nhan-giga.jpg", url: "/brands/giga-electric" },
    { name: "Siemens", image: "https://img.hoplongtech.com/hoplong/uploads/mccb-cau-dao-tu-dong-siemen.jpg", url: "/brands/siemens" },
    { name: "Schneider Devices", image: "https://img.hoplongtech.com/hoplong/uploads/cong-tac-o-cam-se-1.jpg", url: "/brands/schneider-electric" },
    { name: "Omron", image: "https://img.hoplongtech.com/hoplong/uploads/cam-bien-tiem-can-omzon.jpg", url: "/brands/omron" }
  ],

  banners: [
    { title: "Miluz E", image: "https://img.hoplongtech.com/hoplong/logo-hang/banner-3/miluz-e.jpg", url: "/news/miluz-e", width: 466, height: 196 },
    { title: "Biến áp Giga Electric", image: "https://img.hoplongtech.com/hoplong/news/bien-ap-giga-electric-1.jpg", url: "/news/bien-ap-giga-electric", width: 466, height: 196 },
    { title: "Biến tần NiSTRO", image: "https://img.hoplongtech.com/hoplong/news/bien-tan-nistro-3.jpg", url: "/news/bien-tan-nistro", width: 466, height: 196 }
  ],

  products: [
    {
      id: "hlt-p1",
      title: "Biến tần ATV310 3P 380V",
      brand: "Schneider Electric",
      price: 3250000,
      priceFormatted: "3,250,000 ₫",
      image: "https://img.hoplongtech.com/hoplong/uploads/bien-tan-se.jpg",
      category: "bien-tan"
    },
    {
      id: "hlt-p2",
      title: "Nút nhấn nhả phi 22 có đèn",
      brand: "Giga Electric",
      price: 45000,
      priceFormatted: "45,000 ₫",
      image: "https://img.hoplongtech.com/hoplong/uploads/nut-nhan-giga.jpg",
      category: "chuyen-mach-nut-nhan"
    },
    {
      id: "hlt-p3",
      title: "MCCB 3P 100A 36kA 3VM",
      brand: "Siemens",
      price: 1890000,
      priceFormatted: "1,890,000 ₫",
      image: "https://img.hoplongtech.com/hoplong/uploads/mccb-cau-dao-tu-dong-siemen.jpg",
      category: "thiet-bi-dong-cat"
    },
    {
      id: "hlt-p4",
      title: "Cảm biến tiệm cận E2B-M12",
      brand: "Omron",
      price: 320000,
      priceFormatted: "320,000 ₫",
      image: "https://img.hoplongtech.com/hoplong/uploads/cam-bien-tiem-can-omzon.jpg",
      category: "cam-bien"
    },
    {
      id: "hlt-p5",
      title: "Ổ cắm đôi 3 chấu AvatarOn",
      brand: "Schneider Electric",
      price: 115000,
      priceFormatted: "115,000 ₫",
      image: "https://img.hoplongtech.com/hoplong/uploads/cong-tac-o-cam-se-1.jpg",
      category: "chuyen-mach-nut-nhan"
    }
  ]
};
