package egovframework.shop.settle.service.impl;

import java.util.List;
import org.springframework.stereotype.Repository;
import egovframework.rte.psl.dataaccess.EgovAbstractMapper;
import egovframework.shop.settle.service.SettleVO;

@Repository("settledao")
public class SettleDAO extends EgovAbstractMapper {

    public Object selectSettleList(SettleVO vo) throws Exception {
        return selectList("settledao.selectSettleList", vo);
    }

    public Object selectSettle(SettleVO vo) throws Exception {
        return selectOne("settledao.selectSettle", vo);
    }

    public Object selectSettleItemList(SettleVO vo) throws Exception {
        return selectList("settledao.selectSettleItemList", vo);
    }

    public Object updateSettleStat(SettleVO vo) throws Exception {
        return update("settledao.updateSettleStat", vo);
    }

    public Object selectSellerList(SettleVO vo) throws Exception {
        return selectList("settledao.selectSellerList", vo);
    }

    public Object insertSeller(SettleVO vo) throws Exception {
        return insert("settledao.insertSeller", vo);
    }

    public Object selectSalesMonthly(SettleVO vo) throws Exception {
        return selectOne("settledao.selectSalesMonthly", vo);
    }

}
