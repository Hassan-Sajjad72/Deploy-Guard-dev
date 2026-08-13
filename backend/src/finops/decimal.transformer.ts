export const decimalTransformer = {
  to(value?: number | string | null) {
    if (value === undefined || value === null || value === "") {
      return "0";
    }

    return value;
  },
  from(value?: string | number | null) {
    if (value === undefined || value === null || value === "") {
      return 0;
    }

    return Number(value);
  },
};
