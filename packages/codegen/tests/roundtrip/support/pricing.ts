export const discounted = (price: number, percent: number) =>
	Math.round((price * (100 - percent)) / 100);
