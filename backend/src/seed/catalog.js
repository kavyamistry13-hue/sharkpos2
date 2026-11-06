// Demo catalogue: realistic grocery / kirana store. Prices in INR; tax rates are demo values per category.
// Product row: [name, categoryIndex, sellingPrice, unitsPerDay (at ~300 orders/day), supplierIndex, shelfLifeDays|null]
const CATEGORIES = [
  ['Dairy & Eggs', 5], ['Bakery', 5], ['Beverages', 12], ['Snacks', 12], ['Staples & Grains', 5], ['Fruits & Vegetables', 0],
  ['Packaged Foods', 12], ['Personal Care', 18], ['Household', 18], ['Frozen Foods', 12], ['Confectionery', 12], ['Oils & Spices', 5],
];

// [name, phone, email, leadTimeDays]
const SUPPLIERS = [
  ['Fresh Farms Dairy', '9810011001', 'orders@freshfarms.example', 2],
  ['Daily Bake Co', '9810011002', 'sales@dailybake.example', 1],
  ['Metro Wholesale Traders', '9810011003', 'supply@metrowholesale.example', 4],
  ['GreenLeaf Produce', '9810011004', 'orders@greenleaf.example', 1],
  ['Sunrise Beverages', '9810011005', 'orders@sunrisebev.example', 3],
  ['Crunchy Foods Pvt Ltd', '9810011006', 'b2b@crunchyfoods.example', 4],
  ['Golden Grain Mills', '9810011007', 'mill@goldengrain.example', 4],
  ['HomeCare Distributors', '9810011008', 'trade@homecare.example', 5],
  ['PureCare Personal Products', '9810011009', 'orders@purecare.example', 5],
  ['FrostLine Frozen Foods', '9810011010', 'cold@frostline.example', 3],
  ['Sweet Treats Confectionery', '9810011011', 'wholesale@sweettreats.example', 3],
  ['Spice Route Traders', '9810011012', 'spices@spiceroute.example', 6],
];

const P = [
  // Dairy & Eggs (0)
  ['Milk 1L', 0, 58, 18.6, 0, 6], ['Milk 500ml', 0, 30, 7, 0, 6], ['Curd 400g', 0, 42, 6, 0, 10], ['Paneer 200g', 0, 95, 3, 0, 12],
  ['Butter 100g', 0, 62, 3, 0, 60], ['Cheese Slices 200g', 0, 140, 2, 0, 90], ['Eggs 6 Pack', 0, 48, 11, 0, 18], ['Buttermilk 200ml', 0, 15, 4, 0, 10],
  ['Ghee 500ml', 0, 340, 1.2, 0, 180], ['Flavoured Milk 200ml', 0, 25, 3.5, 0, 20],
  // Bakery (1)
  ['Whole Wheat Bread 400g', 1, 45, 14, 1, 4], ['White Bread 400g', 1, 40, 9, 1, 4], ['Pav 6 Pack', 1, 30, 4, 1, 3], ['Burger Buns 4 Pack', 1, 35, 2, 1, 3],
  ['Rusk 200g', 1, 40, 3, 1, 120], ['Chocolate Muffin 2 Pack', 1, 55, 2, 1, 6], ['Tea Cake 180g', 1, 60, 1.5, 1, 20],
  // Beverages (2)
  ['Instant Coffee 200g', 2, 420, 4, 4, null], ['Tea Powder 500g', 2, 235, 4, 4, null], ['Green Tea 25 Bags', 2, 180, 1, 4, null], ['Cola 750ml', 2, 40, 8, 4, null],
  ['Lemon Soda 600ml', 2, 35, 5, 4, null], ['Mango Drink 600ml', 2, 40, 5, 4, null], ['Packaged Water 1L', 2, 20, 15, 4, null], ['Orange Juice 1L', 2, 110, 2.5, 4, 60],
  ['Energy Drink 250ml', 2, 125, 2, 4, null], ['Coconut Water 200ml', 2, 45, 2.5, 4, 90], ['Mineral Water 5L', 2, 70, 2, 4, null], ['Cold Coffee Can 180ml', 2, 70, 2, 4, 120],
  // Snacks (3)
  ['Potato Chips Classic 52g', 3, 20, 12, 5, null], ['Potato Chips Masala 52g', 3, 20, 9, 5, null], ['Corn Puffs 50g', 3, 20, 6, 5, null], ['Namkeen Mix 200g', 3, 55, 6, 5, null],
  ['Salted Peanuts 200g', 3, 60, 3, 5, null], ['Nachos 150g', 3, 85, 2, 5, null], ['Butter Popcorn 90g', 3, 40, 2.5, 5, null], ['Cream Biscuits 120g', 3, 30, 9, 5, null],
  ['Digestive Biscuits 250g', 3, 65, 4, 5, null], ['Glucose Biscuits 200g', 3, 20, 10, 5, null], ['Choco Chip Cookies 150g', 3, 55, 3.5, 5, null], ['Instant Noodles 70g', 3, 14, 14, 5, null],
  ['Cup Noodles 65g', 3, 50, 3, 5, null], ['Banana Chips 150g', 3, 70, 2, 5, null], ['Roasted Makhana 60g', 3, 90, 1.2, 5, null],
  // Staples & Grains (4)
  ['Basmati Rice 5kg', 4, 520, 6, 6, null], ['Sona Masoori Rice 5kg', 4, 380, 3, 6, null], ['Wheat Flour 5kg', 4, 245, 5, 6, null], ['Toor Dal 1kg', 4, 165, 4, 6, null],
  ['Moong Dal 1kg', 4, 140, 2.5, 6, null], ['Chana Dal 1kg', 4, 110, 2.5, 6, null], ['Sugar 1kg', 4, 48, 9, 6, null], ['Salt 1kg', 4, 24, 7, 6, null],
  ['Poha 500g', 4, 45, 2.5, 6, null], ['Semolina 500g', 4, 38, 2, 6, null], ['Besan 500g', 4, 62, 2, 6, null], ['Rolled Oats 400g', 4, 95, 1.5, 6, null],
  ['Corn Flakes 475g', 4, 195, 1.5, 6, null], ['Quinoa 500g', 4, 285, 0.4, 6, null], ['Rajma 1kg', 4, 150, 1.2, 6, null],
  // Fruits & Vegetables (5)
  ['Onion 1kg', 5, 38, 12, 3, 20], ['Potato 1kg', 5, 32, 12, 3, 25], ['Tomato 500g', 5, 28, 9, 3, 6], ['Banana 6 Pcs', 5, 42, 6, 3, 5],
  ['Apple 500g', 5, 95, 3, 3, 14], ['Cucumber 500g', 5, 25, 3.5, 3, 7], ['Coriander Bunch', 5, 15, 6, 3, 4], ['Lemon 4 Pcs', 5, 20, 4.5, 3, 12],
  ['Green Chillies 100g', 5, 12, 4, 3, 6], ['Ginger 100g', 5, 15, 2.5, 3, 14], ['Carrot 500g', 5, 30, 3, 3, 10], ['Capsicum 250g', 5, 30, 2, 3, 8],
  // Packaged Foods (6)
  ['Tomato Ketchup 500g', 6, 120, 2.5, 2, 365], ['Mixed Fruit Jam 200g', 6, 90, 1.8, 2, 365], ['Peanut Butter 340g', 6, 190, 1.2, 2, 365], ['Penne Pasta 500g', 6, 85, 2, 2, null],
  ['Pasta Sauce 200g', 6, 99, 1, 2, 365], ['Mango Pickle 300g', 6, 95, 1.5, 2, 365], ['Mayonnaise 250g', 6, 85, 1.8, 2, 180], ['Tomato Soup Mix 50g', 6, 35, 1.5, 2, 365],
  ['Baked Beans 450g', 6, 110, 0.8, 2, 365], ['Sweet Corn Tin 400g', 6, 105, 0.7, 2, 365], ['Imported Truffle Pasta 250g', 6, 650, 0.1, 2, 365], ['Gourmet Salsa Jar 300g', 6, 340, 0.15, 2, 365],
  // Personal Care (7)
  ['Bath Soap 100g', 7, 38, 7, 8, null], ['Shampoo 180ml', 7, 160, 2, 8, null], ['Toothpaste 150g', 7, 98, 3.5, 8, null], ['Toothbrush', 7, 25, 3, 8, null],
  ['Face Wash 100ml', 7, 175, 1.2, 8, null], ['Hand Wash 250ml', 7, 85, 2, 8, null], ['Deodorant 150ml', 7, 210, 1, 8, null], ['Sanitary Pads 20 Pack', 7, 235, 1.5, 8, null],
  ['Hair Oil 200ml', 7, 110, 1.8, 8, null], ['Body Lotion 200ml', 7, 215, 0.8, 8, null], ['Razor 2 Pack', 7, 45, 1.5, 8, null],
  // Household (8)
  ['Detergent Powder 1kg', 8, 135, 3, 7, null], ['Dishwash Liquid 500ml', 8, 110, 3, 7, null], ['Floor Cleaner 1L', 8, 190, 1.5, 7, null], ['Toilet Cleaner 500ml', 8, 105, 1.5, 7, null],
  ['Garbage Bags 30 Pack', 8, 95, 1.5, 7, null], ['Tissue Box 100 Pulls', 8, 60, 2, 7, null], ['Kitchen Towel 2 Roll', 8, 110, 1, 7, null], ['Scrub Pad 3 Pack', 8, 35, 3, 7, null],
  ['Matchbox 10 Pack', 8, 25, 3, 7, null], ['Candles 6 Pack', 8, 45, 1, 7, null], ['Aluminium Foil 9m', 8, 85, 1.2, 7, null], ['LED Bulb 9W', 8, 99, 0.8, 7, null],
  // Frozen Foods (9)
  ['Frozen Green Peas 500g', 9, 95, 2.5, 9, 180], ['French Fries 420g', 9, 130, 2, 9, 180], ['Vanilla Ice Cream 500ml', 9, 180, 2, 9, 150], ['Frozen Paratha 5 Pack', 9, 95, 2, 9, 120],
  ['Chicken Nuggets 250g', 9, 220, 1, 9, 120], ['Frozen Sweet Corn 500g', 9, 100, 1, 9, 180], ['Ice Cream Cone 60ml', 9, 30, 4, 9, 150],
  // Confectionery (10)
  ['Milk Chocolate Bar 40g', 10, 40, 8, 10, 270], ['Dark Chocolate 80g', 10, 125, 2, 10, 270], ['Candy Mix 150g', 10, 55, 3.5, 10, 365], ['Chewing Gum', 10, 25, 5, 10, 365],
  ['Mint Roll', 10, 10, 7, 10, 365], ['Chocolate Wafer', 10, 30, 6, 10, 200], ['Jelly Cups 6 Pack', 10, 75, 1.5, 10, 200], ['Toffee Jar 400g', 10, 140, 1.2, 10, 365],
  ['Gummy Bears 100g', 10, 70, 2, 10, 300], ['Hazelnut Spread 350g', 10, 295, 0.6, 10, 365],
  // Oils & Spices (11)
  ['Sunflower Oil 1L', 11, 155, 5, 11, null], ['Mustard Oil 1L', 11, 175, 2.5, 11, null], ['Imported Olive Oil 1L', 11, 1150, 0.12, 11, null], ['Turmeric Powder 200g', 11, 70, 2.5, 11, null],
  ['Red Chilli Powder 200g', 11, 85, 2.5, 11, null], ['Coriander Powder 200g', 11, 65, 2, 11, null], ['Cumin Seeds 100g', 11, 75, 2, 11, null], ['Garam Masala 100g', 11, 95, 2, 11, null],
  ['Black Pepper 50g', 11, 85, 0.8, 11, null], ['Cardamom 25g', 11, 175, 0.5, 11, null], ['Mustard Seeds 100g', 11, 28, 1.8, 11, null],
];

const PRODUCTS = P.map(([name, cat, price, perDay, sup, shelf]) => ({ name, cat, price, perDay, sup, shelf }));

const FIRST = ['Aarav', 'Anaya', 'Vivaan', 'Diya', 'Aditya', 'Ishita', 'Rohan', 'Kavya', 'Arjun', 'Sana', 'Karan', 'Neha', 'Vihaan', 'Pooja', 'Siddharth', 'Riya', 'Manish', 'Tanvi', 'Nikhil', 'Shreya', 'Varun', 'Meghna', 'Harsh', 'Aditi', 'Deepak', 'Lakshmi', 'Suresh', 'Fatima', 'Gaurav', 'Nandini', 'Pranav', 'Swati', 'Rajesh', 'Anjali', 'Mohit', 'Bhavna', 'Yash', 'Pallavi', 'Tarun', 'Divya', 'Akash', 'Sneha', 'Naveen', 'Radhika', 'Sanjay', 'Mira', 'Abhishek', 'Komal', 'Vikram', 'Sunita', 'Ayaan', 'Zoya', 'Kunal', 'Padma', 'Rahul', 'Jyoti', 'Dev', 'Alka', 'Imran', 'Tara', 'Omkar', 'Rekha', 'Jatin', 'Seema', 'Ramesh', 'Charu'];
const LAST = ['Sharma', 'Verma', 'Iyer', 'Nair', 'Reddy', 'Patel', 'Gupta', 'Mehta', 'Rao', 'Khan', 'Singh', 'Joshi', 'Menon', 'Kulkarni', 'Das', 'Bose', 'Pillai', 'Shetty', 'Agarwal', 'Chopra'];

module.exports = { CATEGORIES, SUPPLIERS, PRODUCTS, FIRST, LAST };
